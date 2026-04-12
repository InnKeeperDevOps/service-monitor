// Package mockrealtime implements a minimal Kaiad /realtime WebSocket server for exercising the agent transport protocol.
package mockrealtime

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// HelloPayload mirrors the first-frame hello from apps/api buildRealtimeAgentHello (see packages/contracts agentHelloMessageSchema).
type HelloPayload struct {
	RuntimeBackend string // docker, kubernetes, shell — default "docker"
	// PreferredExecutor is the AI CLI for automated fix plans ("cursor" or "claude"). Omitted when empty.
	PreferredExecutor string
}

// DefaultHello returns a dev-friendly hello matching typical Kaiad defaults.
func DefaultHello() HelloPayload {
	return HelloPayload{
		RuntimeBackend: "docker",
	}
}

type helloWire struct {
	Type              string `json:"type"`
	Service           string `json:"service"`
	Runtime           struct {
		Backend string `json:"backend"`
	} `json:"runtime"`
	PreferredExecutor string `json:"preferredExecutor,omitempty"`
}

func (h HelloPayload) marshalJSON() ([]byte, error) {
	backend := h.RuntimeBackend
	if backend == "" {
		backend = "docker"
	}
	var hw helloWire
	hw.Type = "hello"
	hw.Service = "realtime"
	hw.Runtime.Backend = backend
	hw.PreferredExecutor = h.PreferredExecutor

	return json.Marshal(hw)
}

// Config controls the mock /realtime endpoint.
type Config struct {
	// Path is the URL path to mount the WebSocket handler on (e.g. "/realtime").
	Path string
	// RequireToken, if non-empty, rejects connections whose query string lacks token=<RequireToken> (HTTP 401 before upgrade).
	RequireToken string
	Hello HelloPayload
	// InjectAfterFirstHeartbeat, if non-empty, is sent as a single text frame after the first inbound message with type "heartbeat".
	InjectAfterFirstHeartbeat json.RawMessage
	// Logf prints diagnostic lines; if nil, log.Printf is used.
	Logf func(format string, args ...interface{})
	// OnAgentMessage is called for each JSON message received from the agent (after parsing type). Optional; must not block.
	OnAgentMessage func(typ string, raw []byte)
}

// Server is an http.Handler serving the mock WebSocket endpoint at cfg.Path.
type Server struct {
	cfg Config
	up  websocket.Upgrader
}

// NewServer returns a handler that upgrades WebSocket connections and speaks the mock protocol.
func NewServer(cfg Config) *Server {
	if cfg.Path == "" {
		cfg.Path = "/realtime"
	}
	s := &Server{cfg: cfg}
	s.up = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	return s
}

func (s *Server) logf(format string, args ...interface{}) {
	if s.cfg.Logf != nil {
		s.cfg.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != s.cfg.Path {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if tok := s.cfg.RequireToken; tok != "" {
		if r.URL.Query().Get("token") != tok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

	conn, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		s.logf("mock realtime: upgrade: %v", err)
		return
	}

	hello, err := s.cfg.Hello.marshalJSON()
	if err != nil {
		s.logf("mock realtime: hello marshal: %v", err)
		_ = conn.Close()
		return
	}
	if err := conn.WriteMessage(websocket.TextMessage, hello); err != nil {
		s.logf("mock realtime: write hello: %v", err)
		_ = conn.Close()
		return
	}

	var mu sync.Mutex
	var sawHeartbeat bool

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			s.logf("mock realtime: read: %v", err)
			return
		}

		var env struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(data, &env)
		s.logf("mock realtime: inbound type=%s bytes=%d", env.Type, len(data))
		if fn := s.cfg.OnAgentMessage; fn != nil {
			fn(env.Type, data)
		}

		firstHeartbeat := env.Type == "heartbeat" && !sawHeartbeat
		if env.Type == "heartbeat" {
			sawHeartbeat = true
		}

		ack := []byte(`{"type":"ack","accepted":true}`)
		mu.Lock()
		werr := conn.WriteMessage(websocket.TextMessage, ack)
		mu.Unlock()
		if werr != nil {
			s.logf("mock realtime: write ack: %v", werr)
			return
		}

		if firstHeartbeat && len(s.cfg.InjectAfterFirstHeartbeat) > 0 {
			mu.Lock()
			werr = conn.WriteMessage(websocket.TextMessage, s.cfg.InjectAfterFirstHeartbeat)
			mu.Unlock()
			if werr != nil {
				s.logf("mock realtime: inject command: %v", werr)
				return
			}
			s.logf("mock realtime: sent inject frame after first heartbeat ack")
		}
	}
}

// AckPayload matches apps/api: every agent frame is answered with this (see server.ts socket.send after parse).
type AckPayload struct {
	Type      string `json:"type"`
	Accepted  bool   `json:"accepted"`
}

// ParseAck returns true if data is a Kaiad-style ack frame.
func ParseAck(data []byte) (ok bool, err error) {
	var a AckPayload
	if err := json.Unmarshal(data, &a); err != nil {
		return false, err
	}
	if a.Type != "ack" || !a.Accepted {
		return false, nil
	}
	return true, nil
}

// MustJSON returns JSON bytes or panics (for tests / CLI defaults).
func MustJSON(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Errorf("mockrealtime: marshal: %w", err))
	}
	return b
}
