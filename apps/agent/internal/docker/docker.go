package docker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

type ContainerInfo struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Image  string            `json:"Image"`
	Labels map[string]string `json:"Labels"`
}

// RegistryAuth is the X-Registry-Auth header payload used by /images/create.
// Docker takes a base64-encoded JSON object with these fields.
type RegistryAuth struct {
	Username      string `json:"username,omitempty"`
	Password      string `json:"password,omitempty"`
	ServerAddress string `json:"serveraddress,omitempty"`
}

func (a *RegistryAuth) headerValue() (string, error) {
	if a == nil {
		return "", nil
	}
	b, err := json.Marshal(a)
	if err != nil {
		return "", fmt.Errorf("marshal registry auth: %w", err)
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// PortBinding maps a container port to a host port. Used by CreateContainer.
type PortBinding struct {
	ContainerPort int    `json:"containerPort"`
	HostPort      int    `json:"hostPort"`
	Protocol      string `json:"protocol"` // "tcp" or "udp"
}

// CreateContainerOpts is the bag of inputs for CreateContainer. Mirrors the
// Docker engine's POST /containers/create body but with only the fields
// kaiad's redeploy actually uses (image, labels, port bindings).
type CreateContainerOpts struct {
	Name     string
	Image    string
	Labels   map[string]string
	Ports    []PortBinding
	// Restart policy, e.g. "always" or "unless-stopped". Empty leaves it default.
	Restart  string
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

type ContainerStatsNetwork struct {
	RxBytes uint64 `json:"rx_bytes"`
	TxBytes uint64 `json:"tx_bytes"`
}

type ContainerStatsCPU struct {
	CPUUsage struct {
		TotalUsage uint64 `json:"total_usage"`
	} `json:"cpu_usage"`
	SystemCPUUsage uint64 `json:"system_cpu_usage"`
	OnlineCPUs     uint64 `json:"online_cpus"`
}

type ContainerStats struct {
	Read        string                           `json:"read"`
	Name        string                           `json:"name"`
	ID          string                           `json:"id"`
	CPUStats    ContainerStatsCPU                `json:"cpu_stats"`
	PreCPUStats ContainerStatsCPU                `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
		Limit uint64 `json:"limit"`
		Stats struct {
			Cache uint64 `json:"cache"`
		} `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]ContainerStatsNetwork `json:"networks"`
}

// ContainerStats returns a single stats snapshot for a container (Docker /containers/{id}/stats?stream=false).
func (c *Client) ContainerStats(ctx context.Context, id string) (*ContainerStats, error) {
	url := fmt.Sprintf("http://localhost/containers/%s/stats?stream=false", id)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("container stats %s: %w", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("container stats %s: status %d: %s", id, resp.StatusCode, body)
	}
	var s ContainerStats
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, fmt.Errorf("decode container stats %s: %w", id, err)
	}
	return &s, nil
}

// PullImage pulls an image reference from a registry. The optional auth
// is base64-encoded into the X-Registry-Auth header — required when the
// registry is not anonymous (kaiad's built-in registry needs at least
// pull scope).
//
// `imageRef` is the full reference, e.g. "panel.dev.kaiad.dev/foo:1.2.3".
// We split it into fromImage + tag because the daemon API requires that.
//
// The daemon streams pull progress as JSON-newline; we drain it (so the
// daemon doesn't backpressure) and check the last frame for an error.
func (c *Client) PullImage(ctx context.Context, imageRef string, auth *RegistryAuth) error {
	fromImage, tag := splitImageRef(imageRef)
	q := url.Values{}
	q.Set("fromImage", fromImage)
	if tag != "" {
		q.Set("tag", tag)
	}
	req, err := http.NewRequestWithContext(
		ctx,
		"POST",
		fmt.Sprintf("http://localhost/images/create?%s", q.Encode()),
		nil,
	)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	if auth != nil {
		hv, err := auth.headerValue()
		if err != nil {
			return err
		}
		req.Header.Set("X-Registry-Auth", hv)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("pull image %s: %w", imageRef, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pull image %s: status %d: %s", imageRef, resp.StatusCode, body)
	}
	// The daemon emits one JSON frame per progress event. The final frame
	// has either "status" (success) or "errorDetail" (failure). Drain to
	// EOF and surface the last error if any.
	dec := json.NewDecoder(resp.Body)
	var lastErr string
	for {
		var msg map[string]any
		if err := dec.Decode(&msg); err == io.EOF {
			break
		} else if err != nil {
			return fmt.Errorf("pull image %s: decode progress: %w", imageRef, err)
		}
		if e, ok := msg["error"].(string); ok && e != "" {
			lastErr = e
		}
	}
	if lastErr != "" {
		return fmt.Errorf("pull image %s: %s", imageRef, lastErr)
	}
	return nil
}

func splitImageRef(ref string) (fromImage string, tag string) {
	// e.g. "panel.dev.kaiad.dev/svc:abc123" → ("panel.dev.kaiad.dev/svc", "abc123")
	// Tag separator is the LAST ':' after the last '/' — earlier ':' would be
	// a port in the registry hostname.
	slash := -1
	for i := len(ref) - 1; i >= 0; i-- {
		if ref[i] == '/' {
			slash = i
			break
		}
	}
	tail := ref
	if slash >= 0 {
		tail = ref[slash+1:]
	}
	for i := len(tail) - 1; i >= 0; i-- {
		if tail[i] == ':' {
			return ref[:slash+1+i], tail[i+1:]
		}
	}
	return ref, ""
}

// ListContainersAll returns every container including stopped ones. The
// short ListContainers above only shows running ones, which redeploy needs
// to broaden so we can clean up crashed/exited replicas of a previous build.
func (c *Client) ListContainersAll(ctx context.Context) ([]ContainerInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "http://localhost/containers/json?all=true", nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("list containers (all): %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list containers (all): status %d: %s", resp.StatusCode, body)
	}
	var containers []ContainerInfo
	if err := json.NewDecoder(resp.Body).Decode(&containers); err != nil {
		return nil, fmt.Errorf("decode containers: %w", err)
	}
	return containers, nil
}

// CreateContainer creates a container from `opts`. Returns the new
// container id on success. The container is created stopped — call
// StartContainer afterwards.
func (c *Client) CreateContainer(ctx context.Context, opts CreateContainerOpts) (string, error) {
	exposedPorts := map[string]struct{}{}
	portBindings := map[string][]map[string]string{}
	for _, p := range opts.Ports {
		proto := p.Protocol
		if proto == "" {
			proto = "tcp"
		}
		key := fmt.Sprintf("%d/%s", p.ContainerPort, proto)
		exposedPorts[key] = struct{}{}
		// Empty HostPort lets docker pick. >0 publishes deterministically.
		hp := ""
		if p.HostPort > 0 {
			hp = fmt.Sprintf("%d", p.HostPort)
		}
		portBindings[key] = append(portBindings[key], map[string]string{"HostPort": hp})
	}

	hostConfig := map[string]any{
		"PortBindings": portBindings,
	}
	if opts.Restart != "" {
		hostConfig["RestartPolicy"] = map[string]any{"Name": opts.Restart}
	}

	body := map[string]any{
		"Image":        opts.Image,
		"Labels":       opts.Labels,
		"ExposedPorts": exposedPorts,
		"HostConfig":   hostConfig,
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal create body: %w", err)
	}
	q := url.Values{}
	if opts.Name != "" {
		q.Set("name", opts.Name)
	}
	req, err := http.NewRequestWithContext(
		ctx,
		"POST",
		fmt.Sprintf("http://localhost/containers/create?%s", q.Encode()),
		bytes.NewReader(buf),
	)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("create container: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("create container: status %d: %s", resp.StatusCode, respBody)
	}
	var out struct {
		ID string `json:"Id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode create response: %w", err)
	}
	return out.ID, nil
}

// RemoveContainer deletes a container, force-killing if running. Used by
// redeploy to clean up old replicas before starting new ones.
func (c *Client) RemoveContainer(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(
		ctx,
		"DELETE",
		fmt.Sprintf("http://localhost/containers/%s?force=true&v=true", id),
		nil,
	)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("remove container %s: %w", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("remove container %s: status %d: %s", id, resp.StatusCode, body)
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
