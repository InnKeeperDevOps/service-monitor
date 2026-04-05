package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

type ContainerInfo struct {
	ID     string   `json:"Id"`
	Names  []string `json:"Names"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
	Image  string   `json:"Image"`
}

type RuntimeStatus struct {
	ServiceID string `json:"serviceId"`
	State     string `json:"state"`
}

func ParseStatus(serviceID string, state string) RuntimeStatus {
	return RuntimeStatus{ServiceID: serviceID, State: state}
}

type Client struct {
	httpClient *http.Client
	socketPath string
}

func NewClient(socketPath string) *Client {
	if socketPath == "" {
		socketPath = "/var/run/docker.sock"
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return net.DialTimeout("unix", socketPath, 5*time.Second)
		},
	}
	return &Client{
		httpClient: &http.Client{Transport: transport},
		socketPath: socketPath,
	}
}

func (c *Client) SocketPath() string {
	return c.socketPath
}

func (c *Client) ListContainers(ctx context.Context) ([]ContainerInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "http://localhost/containers/json", nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list containers: status %d: %s", resp.StatusCode, body)
	}
	var containers []ContainerInfo
	if err := json.NewDecoder(resp.Body).Decode(&containers); err != nil {
		return nil, fmt.Errorf("decode containers: %w", err)
	}
	return containers, nil
}

func (c *Client) StartContainer(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, "POST",
		fmt.Sprintf("http://localhost/containers/%s/start", id), nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("start container %s: %w", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotModified {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("start container %s: status %d: %s", id, resp.StatusCode, body)
	}
	return nil
}

func (c *Client) StopContainer(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, "POST",
		fmt.Sprintf("http://localhost/containers/%s/stop", id), nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("stop container %s: %w", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotModified {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("stop container %s: status %d: %s", id, resp.StatusCode, body)
	}
	return nil
}

func (c *Client) StreamLogs(ctx context.Context, id string, since string) (io.ReadCloser, error) {
	url := fmt.Sprintf(
		"http://localhost/containers/%s/logs?follow=true&stdout=true&stderr=true&since=%s",
		id, since,
	)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("stream logs %s: %w", id, err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("stream logs %s: status %d: %s", id, resp.StatusCode, body)
	}
	return resp.Body, nil
}
