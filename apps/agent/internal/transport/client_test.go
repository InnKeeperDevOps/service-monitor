package transport_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/service-monitor/agent/internal/transport"
)

func TestClient_commandMessageTriggersCommandAck(t *testing.T) {
	t.Parallel()
	var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	ackCh := make(chan map[string]any, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
		cmd := `{"type":"run_step","commandId":"cmd-ack-1","shell":"echo","env":{}}`
		if err := conn.WriteMessage(websocket.TextMessage, []byte(cmd)); err != nil {
			return
		}
		for range 30 {
			_ = conn.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if err := json.Unmarshal(msg, &m); err != nil {
				continue
			}
			if typ, _ := m["type"].(string); typ == "command_ack" {
				ackCh <- m
				return
			}
		}
	}))
	defer srv.Close()

	wsURL := strings.Replace(srv.URL, "http", "ws", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	client := transport.NewClient(wsURL, "test-agent",
		transport.WithHeartbeatInterval(30*time.Millisecond),
		transport.WithReconnectBackoff(time.Millisecond, 20*time.Millisecond),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	select {
	case m := <-ackCh:
		if m["commandId"] != "cmd-ack-1" {
			t.Fatalf("commandId: want cmd-ack-1, got %v", m["commandId"])
		}
		if m["type"] != "command_ack" {
			t.Fatalf("type: %v", m["type"])
		}
		if m["status"] != "completed" {
			t.Fatalf("status: %v", m["status"])
		}
		if ts, ok := m["ts"].(string); !ok || ts == "" {
			t.Fatalf("expected non-empty ts, got %v", m["ts"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for command_ack")
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("RunContext: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("client did not exit")
	}
}

func TestClient_runCursorPlanMessageTriggersCommandAck(t *testing.T) {
	t.Parallel()
	var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	ackCh := make(chan map[string]any, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
		cmd := `{"type":"run_cursor_plan","commandId":"cmd-plan-1","prompt":"fix bug","workspacePath":"/tmp/ws","env":{}}`
		if err := conn.WriteMessage(websocket.TextMessage, []byte(cmd)); err != nil {
			return
		}
		for range 30 {
			_ = conn.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if err := json.Unmarshal(msg, &m); err != nil {
				continue
			}
			if typ, _ := m["type"].(string); typ == "command_ack" {
				ackCh <- m
				return
			}
		}
	}))
	defer srv.Close()

	wsURL := strings.Replace(srv.URL, "http", "ws", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	client := transport.NewClient(wsURL, "test-agent",
		transport.WithHeartbeatInterval(30*time.Millisecond),
		transport.WithReconnectBackoff(time.Millisecond, 20*time.Millisecond),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	select {
	case m := <-ackCh:
		if m["commandId"] != "cmd-plan-1" {
			t.Fatalf("commandId: want cmd-plan-1, got %v", m["commandId"])
		}
		if m["type"] != "command_ack" {
			t.Fatalf("type: %v", m["type"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for command_ack")
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("RunContext: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("client did not exit")
	}
}

func TestClient_invalidIncomingJSONDoesNotStopHeartbeats(t *testing.T) {
	t.Parallel()
	var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	var beats atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		go func() {
			time.Sleep(40 * time.Millisecond)
			_ = conn.WriteMessage(websocket.TextMessage, []byte("not-json{{{"))
		}()

		for {
			_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var probe struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(msg, &probe) != nil {
				continue
			}
			if probe.Type == "heartbeat" {
				beats.Add(1)
			}
		}
	}))
	defer srv.Close()

	wsURL := strings.Replace(srv.URL, "http", "ws", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	client := transport.NewClient(wsURL, "test-agent",
		transport.WithHeartbeatInterval(25*time.Millisecond),
		transport.WithReconnectBackoff(time.Millisecond, 20*time.Millisecond),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	time.Sleep(300 * time.Millisecond)
	cancel()

	<-errCh

	if n := beats.Load(); n < 2 {
		t.Fatalf("expected heartbeats after invalid JSON, got %d", n)
	}
}

func TestClient_SendLogEventSendsFormattedMessage(t *testing.T) {
	t.Parallel()
	var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	logCh := make(chan map[string]any, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		for {
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if err := json.Unmarshal(msg, &m); err != nil {
				continue
			}
			if typ, _ := m["type"].(string); typ == "log_event" {
				logCh <- m
				return
			}
		}
	}))
	defer srv.Close()

	wsURL := strings.Replace(srv.URL, "http", "ws", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	client := transport.NewClient(wsURL, "test-agent",
		transport.WithHeartbeatInterval(50*time.Millisecond),
		transport.WithReconnectBackoff(time.Millisecond, 20*time.Millisecond),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	time.Sleep(150 * time.Millisecond)

	if err := client.SendLogEvent("test-agent", "svc-1", "error", "something broke"); err != nil {
		t.Fatalf("SendLogEvent: %v", err)
	}

	select {
	case m := <-logCh:
		if m["type"] != "log_event" {
			t.Fatalf("type: want log_event, got %v", m["type"])
		}
		if m["agentId"] != "test-agent" {
			t.Fatalf("agentId: want test-agent, got %v", m["agentId"])
		}
		if m["serviceId"] != "svc-1" {
			t.Fatalf("serviceId: want svc-1, got %v", m["serviceId"])
		}
		if m["level"] != "error" {
			t.Fatalf("level: want error, got %v", m["level"])
		}
		if m["message"] != "something broke" {
			t.Fatalf("message: want 'something broke', got %v", m["message"])
		}
		if ts, ok := m["ts"].(string); !ok || ts == "" {
			t.Fatalf("expected non-empty ts, got %v", m["ts"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for log_event")
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("RunContext: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("client did not exit")
	}
}

func TestClient_duplicateCommandIdOnlyOneCommandAck(t *testing.T) {
	t.Parallel()
	var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	var ackCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
		cmd := `{"type":"run_step","commandId":"cmd-dup-1","shell":"echo","env":{}}`
		if err := conn.WriteMessage(websocket.TextMessage, []byte(cmd)); err != nil {
			return
		}
		if err := conn.WriteMessage(websocket.TextMessage, []byte(cmd)); err != nil {
			return
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
			_, msg, err := conn.ReadMessage()
			if err != nil {
				continue
			}
			var m map[string]any
			if err := json.Unmarshal(msg, &m); err != nil {
				continue
			}
			if typ, _ := m["type"].(string); typ == "command_ack" {
				ackCount.Add(1)
			}
		}
	}))
	defer srv.Close()

	wsURL := strings.Replace(srv.URL, "http", "ws", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	client := transport.NewClient(wsURL, "test-agent",
		transport.WithHeartbeatInterval(30*time.Millisecond),
		transport.WithReconnectBackoff(time.Millisecond, 20*time.Millisecond),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	time.Sleep(1500 * time.Millisecond)
	cancel()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("RunContext: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("client did not exit")
	}

	if n := ackCount.Load(); n != 1 {
		t.Fatalf("command_ack count: want 1, got %d", n)
	}
}
