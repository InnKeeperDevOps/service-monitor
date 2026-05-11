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
	"strings"
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
	// Network: when non-empty, attaches the container to this custom
	// docker network at creation time. The kaiad LB uses this to put
	// service containers + the per-agent nginx on a shared bridge so
	// nginx can resolve service containers by name via docker's
	// embedded DNS (127.0.0.11 on custom networks).
	Network    string
	// NetworkAliases: extra DNS names to attach to this container on
	// `Network`. Docker's embedded DNS round-robins among containers
	// sharing an alias, so a service named "php" with two replicas
	// can be reached by any sibling container via `http://php` and
	// hit either replica. Empty means "only the container name is
	// resolvable".
	NetworkAliases []string
	// Cmd: when non-empty, overrides the image's default entrypoint
	// argv. Used by the LB manager to launch nginx with a known config.
	Cmd        []string
	// Binds: host path → container path bind mounts. Format mirrors
	// `docker run -v <hostPath>:<containerPath>[:ro]`. Used by the LB
	// manager to ship its conf dir into the nginx container.
	Binds      []string
	// Entrypoint: when non-empty, overrides the image's ENTRYPOINT
	// (separate from Cmd, which overrides CMD). Useful when the base
	// image bakes in an entrypoint that wraps the binary.
	Entrypoint []string
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
	if opts.Network != "" {
		hostConfig["NetworkMode"] = opts.Network
	}
	if len(opts.Binds) > 0 {
		hostConfig["Binds"] = opts.Binds
	}

	body := map[string]any{
		"Image":        opts.Image,
		"Labels":       opts.Labels,
		"ExposedPorts": exposedPorts,
		"HostConfig":   hostConfig,
	}
	if len(opts.Cmd) > 0 {
		body["Cmd"] = opts.Cmd
	}
	if len(opts.Entrypoint) > 0 {
		body["Entrypoint"] = opts.Entrypoint
	}
	// NetworkingConfig is the only place docker create accepts
	// per-endpoint settings (Aliases, DriverOpts, IPAMConfig, ...).
	// HostConfig.NetworkMode names the network to attach to, but
	// can't carry aliases — so we mirror the network here when
	// aliases are requested.
	if opts.Network != "" && len(opts.NetworkAliases) > 0 {
		body["NetworkingConfig"] = map[string]any{
			"EndpointsConfig": map[string]any{
				opts.Network: map[string]any{
					"Aliases": opts.NetworkAliases,
				},
			},
		}
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

// EnsureNetwork creates the named bridge network if it doesn't exist
// already and returns its ID. Idempotent — calling it on an existing
// network returns that network's ID without modification.
func (c *Client) EnsureNetwork(ctx context.Context, name string) (string, error) {
	// Try to find an existing one first via the list endpoint with a
	// name filter — fastest path when the LB has been running across
	// agent restarts.
	q := url.Values{}
	q.Set("filters", fmt.Sprintf(`{"name":[%q]}`, name))
	req, err := http.NewRequestWithContext(ctx, "GET",
		fmt.Sprintf("http://localhost/networks?%s", q.Encode()), nil)
	if err != nil {
		return "", fmt.Errorf("list networks request: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("list networks: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		var nets []struct {
			ID   string `json:"Id"`
			Name string `json:"Name"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&nets); err == nil {
			for _, n := range nets {
				if n.Name == name {
					return n.ID, nil
				}
			}
		}
	}

	// Create.
	body, _ := json.Marshal(map[string]any{
		"Name":   name,
		"Driver": "bridge",
	})
	creq, err := http.NewRequestWithContext(ctx, "POST",
		"http://localhost/networks/create", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create network request: %w", err)
	}
	creq.Header.Set("Content-Type", "application/json")
	cresp, err := c.httpClient.Do(creq)
	if err != nil {
		return "", fmt.Errorf("create network: %w", err)
	}
	defer cresp.Body.Close()
	if cresp.StatusCode != http.StatusCreated && cresp.StatusCode != http.StatusConflict {
		respBody, _ := io.ReadAll(cresp.Body)
		return "", fmt.Errorf("create network: status %d: %s", cresp.StatusCode, respBody)
	}
	// 409 = already exists (race). Re-list.
	if cresp.StatusCode == http.StatusConflict {
		return c.EnsureNetwork(ctx, name)
	}
	var out struct {
		ID string `json:"Id"`
	}
	_ = json.NewDecoder(cresp.Body).Decode(&out)
	return out.ID, nil
}

// FindContainerByName returns the matching container's id, or "" when
// none exists. Search includes stopped containers. Docker returns names
// prefixed with "/" — we match the suffix.
func (c *Client) FindContainerByName(ctx context.Context, name string) (string, error) {
	all, err := c.ListContainersAll(ctx)
	if err != nil {
		return "", err
	}
	want := "/" + name
	for _, ci := range all {
		for _, n := range ci.Names {
			if n == want || n == name {
				return ci.ID, nil
			}
		}
	}
	return "", nil
}

// ExecRun runs `cmd` inside the running container and returns the
// combined stdout/stderr. Blocks until the command exits. Non-zero
// exit codes surface as an error so the caller doesn't have to check
// two paths.
func (c *Client) ExecRun(ctx context.Context, ctrID string, cmd []string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          false,
		"Cmd":          cmd,
	})
	req, err := http.NewRequestWithContext(ctx, "POST",
		fmt.Sprintf("http://localhost/containers/%s/exec", ctrID), bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create exec request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("create exec: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		rb, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("create exec: status %d: %s", resp.StatusCode, rb)
	}
	var ec struct {
		ID string `json:"Id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ec); err != nil {
		return "", fmt.Errorf("decode exec id: %w", err)
	}

	// Start with detach=false so we read the streamed output back.
	sBody, _ := json.Marshal(map[string]any{
		"Detach": false,
		"Tty":    false,
	})
	sreq, err := http.NewRequestWithContext(ctx, "POST",
		fmt.Sprintf("http://localhost/exec/%s/start", ec.ID), bytes.NewReader(sBody))
	if err != nil {
		return "", fmt.Errorf("start exec request: %w", err)
	}
	sreq.Header.Set("Content-Type", "application/json")
	sresp, err := c.httpClient.Do(sreq)
	if err != nil {
		return "", fmt.Errorf("start exec: %w", err)
	}
	defer sresp.Body.Close()
	if sresp.StatusCode != http.StatusOK {
		rb, _ := io.ReadAll(sresp.Body)
		return "", fmt.Errorf("start exec: status %d: %s", sresp.StatusCode, rb)
	}
	// Docker multiplexes stdout/stderr with an 8-byte framing header
	// per write when Tty=false. We don't care which stream each chunk
	// came from for our purposes (everything is small + diagnostic),
	// so just concatenate the payloads.
	output, err := readMuxedStream(sresp.Body)
	if err != nil {
		return string(output), fmt.Errorf("read exec output: %w", err)
	}

	// Inspect for exit code so callers can fail fast on a non-zero rc.
	ireq, err := http.NewRequestWithContext(ctx, "GET",
		fmt.Sprintf("http://localhost/exec/%s/json", ec.ID), nil)
	if err != nil {
		return string(output), nil
	}
	iresp, err := c.httpClient.Do(ireq)
	if err != nil {
		return string(output), nil
	}
	defer iresp.Body.Close()
	var info struct {
		ExitCode int  `json:"ExitCode"`
		Running  bool `json:"Running"`
	}
	if err := json.NewDecoder(iresp.Body).Decode(&info); err == nil && !info.Running && info.ExitCode != 0 {
		return string(output), fmt.Errorf("exec exited %d: %s", info.ExitCode, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}

// readMuxedStream strips the 8-byte stream-multiplex header docker
// adds in front of every stdout/stderr write when no TTY is attached.
// Header layout: [stream(1) 0(3) size_BE(4)]. We don't care which
// stream emitted what — just concatenate the payload bytes.
func readMuxedStream(r io.Reader) ([]byte, error) {
	var out bytes.Buffer
	hdr := make([]byte, 8)
	for {
		_, err := io.ReadFull(r, hdr)
		if err == io.EOF {
			return out.Bytes(), nil
		}
		if err != nil {
			return out.Bytes(), err
		}
		size := int(uint32(hdr[4])<<24 | uint32(hdr[5])<<16 | uint32(hdr[6])<<8 | uint32(hdr[7]))
		if size == 0 {
			continue
		}
		if _, err := io.CopyN(&out, r, int64(size)); err != nil {
			return out.Bytes(), err
		}
	}
}

// PutArchive uploads a tar archive into the container's filesystem at
// `dirPath`. The tar's entries are extracted relative to dirPath. Used
// by the LB manager to ship rendered nginx config snippets into the
// running nginx container without a bind mount.
func (c *Client) PutArchive(ctx context.Context, ctrID, dirPath string, tarBytes []byte) error {
	q := url.Values{}
	q.Set("path", dirPath)
	req, err := http.NewRequestWithContext(ctx, "PUT",
		fmt.Sprintf("http://localhost/containers/%s/archive?%s", ctrID, q.Encode()),
		bytes.NewReader(tarBytes))
	if err != nil {
		return fmt.Errorf("put archive request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-tar")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("put archive: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("put archive: status %d: %s", resp.StatusCode, body)
	}
	return nil
}
