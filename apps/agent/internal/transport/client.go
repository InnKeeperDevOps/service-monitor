package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/service-monitor/agent/internal/agentdebug"
)

type CommandHandler interface {
	HandleCommand(ctx context.Context, cmdType string, payload map[string]interface{}) (success bool, output string)
}

// AgentHello is the first message from Kaiad /realtime (see packages/contracts agentHelloMessageSchema).
type AgentHello struct {
	Service string `json:"service"`
	Runtime struct {
		Backend string `json:"backend"`
	} `json:"runtime"`
	// PreferredExecutor is the AI CLI the agent should use for automated fix plans ("cursor" or "claude").
	PreferredExecutor string `json:"preferredExecutor,omitempty"`
}

type heartbeatRuntime struct {
	Backend string `json:"backend"`
}

type heartbeatMessage struct {
	Type         string            `json:"type"`
	AgentID      string            `json:"agentId"`
	Ts           string            `json:"ts"`
	Capacity     int               `json:"capacity"`
	TenantID     string            `json:"tenantId,omitempty"`
	AgentVersion string            `json:"agentVersion,omitempty"`
	Runtime      *heartbeatRuntime `json:"runtime,omitempty"`
}

// ErrPermanentRejection is returned from RunContext when the platform
// rejected the agent's connection in a way that retrying won't fix —
// notably an INVALID_TOKEN (the enrollment token was already consumed or
// expired). The caller (main.go) should surface this as a fatal error so
// the orchestrator (kubelet, systemd) restarts the agent process; on
// restart the agent reads the (presumably re-minted) SM_ENROLLMENT_TOKEN
// environment variable fresh.
var ErrPermanentRejection = errors.New("transport: permanent rejection by control plane")

// permanentApiErrorCodes is the set of `apiError.code` values from the
// platform that mean "give up; reconnecting won't help." Mirrors the
// codes server.ts emits before closing the WS during /realtime
// validation. INVALID_MESSAGE / ENROLLMENT_STORE_UNAVAILABLE are
// intentionally NOT in this list — the first is an agent bug worth
// retrying once the agent's view of the protocol is sane, the second is
// a control-plane outage that should resolve.
var permanentApiErrorCodes = map[string]struct{}{
	"INVALID_TOKEN": {},
	"UNAUTHORIZED":  {},
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

// appLogErrorMessage carries an error log line plus the buffered context lines
// the agent saw immediately before it. See packages/contracts/src/realtime.ts
// `appLogErrorSchema` for the receiving end.
type appLogErrorMessage struct {
	Type         string   `json:"type"`
	AgentID      string   `json:"agentId"`
	ServiceID    string   `json:"serviceId"`
	Ts           string   `json:"ts"`
	Message      string   `json:"message"`
	ContextLines []string `json:"contextLines"`
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
	onHello           func(AgentHello)

	seenMu   sync.Mutex
	seenCmds map[string]struct{}

	writeMu    sync.Mutex
	activeConn *websocket.Conn

	ackOnce sync.Once

	// protocolDebug logs WebSocket protocol interactions when set (see SM_AGENT_DEBUG or WithProtocolDebugLog).
	protocolDebug func(format string, args ...interface{})

	// hostStats, when set, runs after each heartbeat to send optional host_stats JSON (see packages/contracts).
	hostStats func(agentID string) ([]byte, error)

	// appStats, when set, runs after hostStats each tick to send zero or more app_stats frames (per container).
	appStats func(agentID string) ([][]byte, error)

	// runtime is the agent's resolved runtime backend ("docker" |
	// "kubernetes" | "shell"). Set after the hello frame's backend
	// resolution completes (see SetRuntime); included in every
	// outbound heartbeat so the platform can distinguish docker-mode
	// vs k8s-mode agents in the UI without inferring it elsewhere.
	runtimeMu sync.Mutex
	runtime   string
}

// SetRuntime records the runtime backend the agent has configured
// itself for. Safe to call from any goroutine. Subsequent heartbeats
// include this value; passing "" clears it (heartbeat omits the
// `runtime` field, mirroring agents that haven't reported yet).
func (c *Client) SetRuntime(backend string) {
	c.runtimeMu.Lock()
	defer c.runtimeMu.Unlock()
	c.runtime = backend
}

func (c *Client) currentRuntime() string {
	c.runtimeMu.Lock()
	defer c.runtimeMu.Unlock()
	return c.runtime
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

// OnHello is invoked when the server sends type "hello" (includes tenant agent runtime from Kaiad).
func OnHello(fn func(AgentHello)) ClientOption {
	return func(c *Client) {
		c.onHello = fn
	}
}

// WithProtocolDebugLog sets a logger for inbound/outbound realtime frames. When nil and SM_AGENT_DEBUG is enabled,
// the default logger uses the standard log package with prefix [agent:transport].
func WithProtocolDebugLog(fn func(format string, args ...interface{})) ClientOption {
	return func(c *Client) {
		c.protocolDebug = fn
	}
}

// WithHostStatsCollector sets a callback that returns JSON for a host_stats frame (or nil/empty to skip).
// Non-fatal errors are logged when protocol debug is enabled; send failures end the session like heartbeat.
func WithHostStatsCollector(fn func(agentID string) ([]byte, error)) ClientOption {
	return func(c *Client) {
		c.hostStats = fn
	}
}

// WithAppStatsCollector sets a callback that returns zero or more JSON app_stats frames per tick
// (one per container). Collector errors are logged (debug) and do not end the session.
func WithAppStatsCollector(fn func(agentID string) ([][]byte, error)) ClientOption {
	return func(c *Client) {
		c.appStats = fn
	}
}

// DefaultAgentVersion is the version the agent reports to the control
// plane unless overridden via WithVersion(...) or $SM_AGENT_VERSION.
// Bump on every agent release.
const DefaultAgentVersion = "0.1.5"

func NewClient(url string, agentID string, opts ...ClientOption) *Client {
	c := &Client{
		url:               url,
		agentID:           agentID,
		version:           DefaultAgentVersion,
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
	if v := os.Getenv("SM_AGENT_VERSION"); v != "" && c.version == DefaultAgentVersion {
		c.version = v
	}
	if c.protocolDebug == nil && agentdebug.Enabled() {
		c.protocolDebug = func(format string, args ...interface{}) {
			log.Printf("[agent:transport] "+format, args...)
		}
	}
	return c
}

// SendPlatformMessage marshals payload to JSON and writes it on the
// active realtime websocket. Used by command handlers (notably
// redeploy_service) to push observation messages such as
// `lb_status_report`. No-op when no connection is active — caller
// should treat that as best-effort.
func (c *Client) SendPlatformMessage(payload map[string]interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal platform message: %w", err)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.activeConn == nil {
		return fmt.Errorf("no active websocket")
	}
	t, _ := payload["type"].(string)
	c.protoDebug("outbound %s bytes=%d", t, len(body))
	return c.activeConn.WriteMessage(websocket.TextMessage, body)
}

func (c *Client) protoDebug(format string, args ...interface{}) {
	if c.protocolDebug == nil {
		return
	}
	c.protocolDebug(format, args...)
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

// CloseActiveForReconnect closes the WebSocket so RunContext reconnects and receives a fresh hello (e.g. after Kaiad settings change).
func (c *Client) CloseActiveForReconnect() {
	c.writeMu.Lock()
	conn := c.activeConn
	c.writeMu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
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
			c.protoDebug("dial error attempt=%d: %v", attempt, err)
			if err := c.sleepBackoff(ctx, attempt); err != nil {
				return err
			}
			attempt++
			continue
		}
		attempt = 0
		c.protoDebug("websocket connected")

		err = c.runSession(ctx, conn)

		if err != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, ErrPermanentRejection) {
			// Don't retry forever on a token the platform won't accept.
			// Returning a non-nil error makes main.go exit non-zero so
			// kubelet/systemd restarts us with the latest env vars (see
			// the operator's stale-secret re-mint path).
			return err
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
	c.protoDebug("session: initial heartbeat sent")
	if err := c.sendHostStats(); err != nil {
		return err
	}
	if err := c.sendAppStats(); err != nil {
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
			if err := c.sendHostStats(); err != nil {
				return err
			}
			if err := c.sendAppStats(); err != nil {
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
	if rt := c.currentRuntime(); rt != "" {
		msg.Runtime = &heartbeatRuntime{Backend: rt}
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
	c.protoDebug("outbound heartbeat agentId=%s bytes=%d", c.agentID, len(payload))
	return nil
}

func (c *Client) sendHostStats() error {
	if c.hostStats == nil {
		return nil
	}
	payload, err := c.hostStats(c.agentID)
	if err != nil {
		c.protoDebug("host_stats collect: %v", err)
		return nil
	}
	if len(payload) == 0 {
		return nil
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.activeConn == nil {
		return fmt.Errorf("not connected")
	}
	if err := c.activeConn.WriteMessage(websocket.TextMessage, payload); err != nil {
		return fmt.Errorf("send host_stats: %w", err)
	}
	c.protoDebug("outbound host_stats bytes=%d", len(payload))
	return nil
}

func (c *Client) sendAppStats() error {
	if c.appStats == nil {
		return nil
	}
	frames, err := c.appStats(c.agentID)
	if err != nil {
		c.protoDebug("app_stats collect: %v", err)
		return nil
	}
	if len(frames) == 0 {
		return nil
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.activeConn == nil {
		return fmt.Errorf("not connected")
	}
	totalBytes := 0
	for _, f := range frames {
		if len(f) == 0 {
			continue
		}
		if err := c.activeConn.WriteMessage(websocket.TextMessage, f); err != nil {
			return fmt.Errorf("send app_stats: %w", err)
		}
		totalBytes += len(f)
	}
	c.protoDebug("outbound app_stats frames=%d bytes=%d", len(frames), totalBytes)
	return nil
}

// SendAppLogError emits an `app_log_error` frame with the buffered context
// lines that preceded `message`. Best-effort: a missing connection returns
// an error but does not interrupt the surrounding log_event flow.
func (c *Client) SendAppLogError(_, serviceID, message string, contextLines []string, ts string) error {
	if ts == "" {
		ts = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if contextLines == nil {
		contextLines = []string{}
	}
	msg := appLogErrorMessage{
		Type:         "app_log_error",
		AgentID:      c.agentID,
		ServiceID:    serviceID,
		Ts:           ts,
		Message:      message,
		ContextLines: contextLines,
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
	if err := c.activeConn.WriteMessage(websocket.TextMessage, payload); err != nil {
		return fmt.Errorf("send app_log_error: %w", err)
	}
	c.protoDebug("outbound app_log_error service=%s ctxLines=%d bytes=%d", serviceID, len(contextLines), len(payload))
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
		// apiError shape: server emits `{ code, message, correlationId? }`
		// when rejecting a /realtime upgrade (INVALID_TOKEN, UNAUTHORIZED,
		// etc.) before closing the socket. There's no `type`, so the
		// command-dispatch branches below would silently drop it.
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		c.protoDebug("inbound invalid JSON (%d bytes): %v", len(data), err)
		return
	}
	c.protoDebug("inbound type=%s commandId=%s bytes=%d", envelope.Type, envelope.CommandID, len(data))

	if envelope.Type == "" && envelope.Code != "" {
		// apiError frame — surface visibly and (for permanent codes) bail
		// the whole process so the orchestrator restarts us with a fresh
		// SM_ENROLLMENT_TOKEN env (the operator's stale-secret detection
		// will have re-minted by then).
		log.Printf("control plane rejected connection: code=%s message=%q", envelope.Code, envelope.Message)
		if _, permanent := permanentApiErrorCodes[envelope.Code]; permanent {
			select {
			case errCh <- fmt.Errorf("%w: %s: %s", ErrPermanentRejection, envelope.Code, envelope.Message):
			default:
				// Buffer is 1; if the read loop already wrote the close error,
				// it's about to return anyway — leave it alone.
			}
		}
		return
	}

	if envelope.Type == "hello" {
		var hello AgentHello
		if json.Unmarshal(data, &hello) != nil {
			return
		}
		b := hello.Runtime.Backend
		if b == "" {
			b = "(empty)"
		}
		c.protoDebug("hello runtime.backend=%s service=%s", b, hello.Service)
		if c.onHello != nil {
			c.onHello(hello)
		}
		return
	}

	// API responds to heartbeats with { type: "ack", accepted: true } (see apps/api server /realtime).
	if envelope.Type == "heartbeat_ack" || envelope.Type == "ack" {
		c.protoDebug("inbound server ack (firstAck callback may run)")
		if c.onFirstAck != nil {
			c.ackOnce.Do(c.onFirstAck)
		}
		return
	}

	if envelope.CommandID == "" {
		c.protoDebug("inbound ignored (no commandId) type=%s", envelope.Type)
		return
	}
	switch envelope.Type {
	case "run_step", "docker_op", "cancel_run", "sync_desired_state", "run_cursor_plan", "run_claude_plan", "run_toolchain", "receive_source_archive", "run_fix_plan", "redeploy_service", "teardown_service":
	default:
		c.protoDebug("inbound ignored unknown command type=%s", envelope.Type)
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

	c.protoDebug("dispatch command type=%s commandId=%s", envelope.Type, envelope.CommandID)
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
		c.protoDebug("handler result commandId=%s success=%v outputLen=%d", commandID, success, len(out))
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
	c.protoDebug("outbound command_ack commandId=%s status=%s bytes=%d", commandID, status, len(payload))
	if werr != nil {
		select {
		case errCh <- fmt.Errorf("send command_ack: %w", werr):
		default:
		}
	}
}
