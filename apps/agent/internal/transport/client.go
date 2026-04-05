package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type CommandHandler interface {
	HandleCommand(ctx context.Context, cmdType string, payload map[string]interface{}) (success bool, output string)
}

type heartbeatMessage struct {
	Type         string `json:"type"`
	AgentID      string `json:"agentId"`
	Ts           string `json:"ts"`
	Capacity     int    `json:"capacity"`
	TenantID     string `json:"tenantId,omitempty"`
	AgentVersion string `json:"agentVersion,omitempty"`
}

type commandAckMessage struct {
	Type      string `json:"type"`
	CommandID string `json:"commandId"`
	Status    string `json:"status"`
	Output    string `json:"output,omitempty"`
	Ts        string `json:"ts"`
}

type logEventMessage struct {
	Type      string `json:"type"`
	AgentID   string `json:"agentId"`
	ServiceID string `json:"serviceId"`
	Level     string `json:"level"`
	Message   string `json:"message"`
	Ts        string `json:"ts"`
}

type Client struct {
	url               string
	agentID           string
	Token             string
	tenantID          string
	version           string
	heartbeatInterval time.Duration
	minBackoff        time.Duration
	maxBackoff        time.Duration
	rng               *rand.Rand
	handler           CommandHandler
	onFirstAck        func()

	seenMu   sync.Mutex
	seenCmds map[string]struct{}

	writeMu    sync.Mutex
	activeConn *websocket.Conn

	ackOnce sync.Once
}

type ClientOption func(*Client)

func WithHeartbeatInterval(d time.Duration) ClientOption {
	return func(c *Client) {
		c.heartbeatInterval = d
	}
}

func WithReconnectBackoff(min, max time.Duration) ClientOption {
	return func(c *Client) {
		c.minBackoff = min
		c.maxBackoff = max
	}
}

func WithRand(r *rand.Rand) ClientOption {
	return func(c *Client) {
		c.rng = r
	}
}

func WithCommandHandler(h CommandHandler) ClientOption {
	return func(c *Client) {
		c.handler = h
	}
}

func WithTenantID(id string) ClientOption {
	return func(c *Client) {
		c.tenantID = id
	}
}

func WithVersion(v string) ClientOption {
	return func(c *Client) {
		c.version = v
	}
}

func WithToken(token string) ClientOption {
	return func(c *Client) {
		c.Token = token
	}
}

func OnFirstAck(fn func()) ClientOption {
	return func(c *Client) {
		c.onFirstAck = fn
	}
}

func NewClient(url string, agentID string, opts ...ClientOption) *Client {
	c := &Client{
		url:               url,
		agentID:           agentID,
		version:           "0.1.0",
		heartbeatInterval: 10 * time.Second,
		minBackoff:        time.Second,
		maxBackoff:        60 * time.Second,
	}
	if c.agentID == "" {
		c.agentID = "agent-local"
	}
	for _, o := range opts {
		o(c)
	}
	if c.rng == nil {
		c.rng = rand.New(rand.NewSource(time.Now().UnixNano()))
	}
	if v := os.Getenv("SM_AGENT_VERSION"); v != "" && c.version == "0.1.0" {
		c.version = v
	}
	return c
}

func (c *Client) Run() error {
	return c.RunContext(context.Background())
}

func (c *Client) dialURL() string {
	if c.Token == "" {
		return c.url
	}
	u, err := url.Parse(c.url)
	if err != nil {
		return c.url
	}
	q := u.Query()
	q.Set("token", c.Token)
	u.RawQuery = q.Encode()
	return u.String()
}

func (c *Client) RunContext(ctx context.Context) error {
	attempt := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		dialer := websocket.DefaultDialer
		conn, _, err := dialer.DialContext(ctx, c.dialURL(), nil)
		if err != nil {
			if err := c.sleepBackoff(ctx, attempt); err != nil {
				return err
			}
			attempt++
			continue
		}
		attempt = 0

		err = c.runSession(ctx, conn)

		if err != nil && ctx.Err() != nil {
			return ctx.Err()
		}

		if err := c.sleepBackoff(ctx, attempt); err != nil {
			return err
		}
		attempt++
	}
}

func (c *Client) sleepBackoff(ctx context.Context, attempt int) error {
	d := nextReconnectDelay(attempt, c.minBackoff, c.maxBackoff, c.rng)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

func (c *Client) runSession(ctx context.Context, conn *websocket.Conn) error {
	errCh := make(chan error, 1)
	readCtx, cancelRead := context.WithCancel(ctx)

	c.writeMu.Lock()
	c.activeConn = conn
	c.writeMu.Unlock()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		c.readLoop(readCtx, conn, errCh)
	}()

	ticker := time.NewTicker(c.heartbeatInterval)
	defer ticker.Stop()
	defer func() {
		cancelRead()
		c.writeMu.Lock()
		c.activeConn = nil
		c.writeMu.Unlock()
		_ = conn.Close()
		wg.Wait()
	}()

	if err := c.sendHeartbeat(); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errCh:
			return err
		case <-ticker.C:
			if err := c.sendHeartbeat(); err != nil {
				return err
			}
		}
	}
}

func (c *Client) sendHeartbeat() error {
	msg := heartbeatMessage{
		Type:         "heartbeat",
		AgentID:      c.agentID,
		Ts:           time.Now().UTC().Format(time.RFC3339Nano),
		Capacity:     4,
		TenantID:     c.tenantID,
		AgentVersion: c.version,
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal heartbeat: %w", err)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.activeConn == nil {
		return fmt.Errorf("not connected")
	}
	if err := c.activeConn.WriteMessage(websocket.TextMessage, payload); err != nil {
		return fmt.Errorf("send heartbeat: %w", err)
	}
	return nil
}

func (c *Client) SendLogEvent(_, serviceID, level, message string) error {
	msg := logEventMessage{
		Type:      "log_event",
		AgentID:   c.agentID,
		ServiceID: serviceID,
		Level:     level,
		Message:   message,
		Ts:        time.Now().UTC().Format(time.RFC3339Nano),
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.activeConn == nil {
		return fmt.Errorf("not connected")
	}
	return c.activeConn.WriteMessage(websocket.TextMessage, payload)
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn, errCh chan<- error) {
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		_, data, err := conn.ReadMessage()
		if err != nil {
			errCh <- err
			return
		}
		c.handleIncoming(ctx, errCh, data)
	}
}

func (c *Client) handleIncoming(ctx context.Context, errCh chan<- error, data []byte) {
	var envelope struct {
		Type      string `json:"type"`
		CommandID string `json:"commandId"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return
	}

	if envelope.Type == "heartbeat_ack" {
		if c.onFirstAck != nil {
			c.ackOnce.Do(c.onFirstAck)
		}
		return
	}

	if envelope.CommandID == "" {
		return
	}
	switch envelope.Type {
	case "run_step", "docker_op", "cancel_run", "run_cursor_plan", "run_claude_plan":
	default:
		return
	}

	c.seenMu.Lock()
	if c.seenCmds == nil {
		c.seenCmds = make(map[string]struct{})
	}
	if _, dup := c.seenCmds[envelope.CommandID]; dup {
		c.seenMu.Unlock()
		return
	}
	c.seenCmds[envelope.CommandID] = struct{}{}
	c.seenMu.Unlock()

	go c.executeAndAck(ctx, errCh, envelope.Type, envelope.CommandID, data)
}

func (c *Client) executeAndAck(ctx context.Context, errCh chan<- error, cmdType, commandID string, rawData []byte) {
	status := "completed"
	output := ""

	if c.handler != nil {
		var full map[string]interface{}
		_ = json.Unmarshal(rawData, &full)
		success, out := c.handler.HandleCommand(ctx, cmdType, full)
		output = out
		if !success {
			status = "failed"
		}
	}

	ack := commandAckMessage{
		Type:      "command_ack",
		CommandID: commandID,
		Status:    status,
		Output:    output,
		Ts:        time.Now().UTC().Format(time.RFC3339Nano),
	}
	payload, err := json.Marshal(ack)
	if err != nil {
		return
	}
	c.writeMu.Lock()
	var werr error
	if c.activeConn != nil {
		werr = c.activeConn.WriteMessage(websocket.TextMessage, payload)
	}
	c.writeMu.Unlock()
	if werr != nil {
		select {
		case errCh <- fmt.Errorf("send command_ack: %w", werr):
		default:
		}
	}
}
