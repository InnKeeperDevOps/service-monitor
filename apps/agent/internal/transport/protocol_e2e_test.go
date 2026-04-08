// End-to-end protocol tests: agent WebSocket client against an API-shaped server that mirrors
// packages/contracts realtime schemas (hello, ack, platform→agent commands, agent→platform
// heartbeat, log_event, command_ack). Keeps the Go agent aligned with apps/api /realtime.
package transport_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/service-monitor/agent/internal/transport"
)

// apiLikeRealtimeSession mimics apps/api WebSocket /realtime: hello on connect, then
// { type: "ack", accepted: true } for each agent message, matching packages/contracts.
func apiLikeRealtimeSession(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"hello","service":"realtime","runtime":{"backend":"docker"}}`)); err != nil {
		t.Fatalf("hello: %v", err)
	}
}

func readUntilHeartbeat(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var probe struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(msg, &probe) != nil {
			continue
		}
		if probe.Type == "heartbeat" {
			return
		}
	}
	t.Fatal("timeout waiting for heartbeat")
}

func writeAck(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"ack","accepted":true}`)); err != nil {
		t.Fatalf("ack: %v", err)
	}
}

// readUntilCommandAck returns when the client sends command_ack with the given commandId.
func readUntilCommandAck(t *testing.T, conn *websocket.Conn, wantCommandID string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(time.Now().Add(1 * time.Second))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(msg, &m); err != nil {
			continue
		}
		typ, _ := m["type"].(string)
		if typ == "heartbeat" {
			writeAck(t, conn)
			continue
		}
		if typ == "command_ack" {
			if m["commandId"] == wantCommandID {
				return m
			}
		}
	}
	t.Fatalf("timeout waiting for command_ack for %s", wantCommandID)
	return nil
}

func TestE2E_RealtimeHelloHeartbeatAck(t *testing.T) {
	t.Parallel()
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		apiLikeRealtimeSession(t, conn)
		readUntilHeartbeat(t, conn)
		writeAck(t, conn)
		_, _, _ = conn.ReadMessage()
	}))
	defer srv.Close()

	wsURL := strings.Replace(srv.URL, "http", "ws", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	acked := make(chan struct{})
	client := transport.NewClient(wsURL, "e2e-agent",
		transport.WithHeartbeatInterval(40*time.Millisecond),
		transport.WithReconnectBackoff(time.Millisecond, 20*time.Millisecond),
		transport.OnFirstAck(func() { close(acked) }),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	select {
	case <-acked:
	case <-time.After(4 * time.Second):
		t.Fatal("timeout waiting for OnFirstAck (hello + heartbeat + ack)")
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("RunContext: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("client did not exit")
	}
}

func TestE2E_RealtimeTokenAppendedToDialURL(t *testing.T) {
	t.Parallel()
	const wantToken = "enroll-test-token-abc"
	var gotToken, gotV string
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.URL.Query().Get("token")
		gotV = r.URL.Query().Get("v")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"hello","service":"realtime","runtime":{"backend":"docker"}}`))
		readUntilHeartbeat(t, conn)
		writeAck(t, conn)
		_, _, _ = conn.ReadMessage()
	}))
	defer srv.Close()

	base := strings.Replace(srv.URL, "http", "ws", 1) + "/realtime"
	wsURL := base + "?v=1"
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	client := transport.NewClient(wsURL, "tok-agent",
		transport.WithToken(wantToken),
		transport.WithHeartbeatInterval(50*time.Millisecond),
		transport.WithReconnectBackoff(time.Millisecond, 20*time.Millisecond),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	time.Sleep(200 * time.Millisecond)
	cancel()
	<-errCh

	if gotToken != wantToken {
		t.Fatalf("token query: want %q, got %q", wantToken, gotToken)
	}
	if gotV != "1" {
		t.Fatalf("existing query param v: want 1, got %q", gotV)
	}
}

func TestE2E_AllPlatformCommandTypesYieldCommandAck(t *testing.T) {
	t.Parallel()
	cmds := []struct {
		name      string
		commandID string
		json      string
	}{
		{"run_step", "cmd-run-step", `{"type":"run_step","commandId":"cmd-run-step","shell":"echo e2e","env":{}}`},
		{"docker_op", "cmd-docker", `{"type":"docker_op","commandId":"cmd-docker","operation":"build","args":{"path":".","tag":"e2e-test"}}`},
		{"cancel_run", "cmd-cancel", `{"type":"cancel_run","commandId":"cmd-cancel","targetCommandId":"other"}`},
		{"sync_desired_state", "cmd-sync", `{"type":"sync_desired_state","commandId":"cmd-sync","desiredContainers":[{"serviceId":"s1","image":"nginx:latest","state":"running"}]}`},
		{"run_cursor_plan", "cmd-cursor", `{"type":"run_cursor_plan","commandId":"cmd-cursor","prompt":"noop","workspacePath":"/tmp"}`},
		{"run_claude_plan", "cmd-claude", `{"type":"run_claude_plan","commandId":"cmd-claude","prompt":"noop","workspacePath":"/tmp"}`},
		{"run_toolchain", "cmd-tc", `{"type":"run_toolchain","commandId":"cmd-tc","language":"python3","path":"/tmp/nope.py"}`},
		{"receive_source_archive", "cmd-arch", `{"type":"receive_source_archive","commandId":"cmd-arch","url":"https://example.invalid/app.tar.gz"}`},
	}

	for _, tc := range cmds {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
			serverDone := make(chan struct{})
			var once sync.Once

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()

				apiLikeRealtimeSession(t, conn)
				readUntilHeartbeat(t, conn)
				writeAck(t, conn)
				if err := conn.WriteMessage(websocket.TextMessage, []byte(tc.json)); err != nil {
					t.Errorf("send command: %v", err)
					return
				}
				m := readUntilCommandAck(t, conn, tc.commandID)
				if m["type"] != "command_ack" {
					t.Errorf("type: %v", m["type"])
				}
				st, _ := m["status"].(string)
				if st != "completed" {
					t.Errorf("status: want completed, got %v", st)
				}
				once.Do(func() { close(serverDone) })
			}))
			defer srv.Close()

			wsURL := strings.Replace(srv.URL, "http", "ws", 1)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			// Nil handler: protocol-only (no shell/docker); every inbound command completes successfully.
			client := transport.NewClient(wsURL, "e2e-agent",
				transport.WithHeartbeatInterval(35*time.Millisecond),
				transport.WithReconnectBackoff(time.Millisecond, 30*time.Millisecond),
			)

			errCh := make(chan error, 1)
			go func() { errCh <- client.RunContext(ctx) }()

			select {
			case <-serverDone:
				cancel()
			case <-time.After(12 * time.Second):
				t.Fatal("timeout waiting for server to observe command_ack")
			}

			select {
			case err := <-errCh:
				if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("RunContext: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("client did not exit after cancel")
			}
		})
	}
}

func TestE2E_LogEventRoundTrip(t *testing.T) {
	t.Parallel()
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	logSeen := make(chan map[string]any, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		apiLikeRealtimeSession(t, conn)
		readUntilHeartbeat(t, conn)
		writeAck(t, conn)

		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			_ = conn.SetReadDeadline(time.Now().Add(800 * time.Millisecond))
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(msg, &m) != nil {
				continue
			}
			if m["type"] == "log_event" {
				writeAck(t, conn)
				logSeen <- m
				return
			}
			if m["type"] == "heartbeat" {
				writeAck(t, conn)
			}
		}
	}))
	defer srv.Close()

	wsURL := strings.Replace(srv.URL, "http", "ws", 1)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	client := transport.NewClient(wsURL, "log-agent",
		transport.WithHeartbeatInterval(40*time.Millisecond),
		transport.WithReconnectBackoff(time.Millisecond, 20*time.Millisecond),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	time.Sleep(120 * time.Millisecond)
	if err := client.SendLogEvent("log-agent", "svc-e2e", "info", "hello from e2e"); err != nil {
		t.Fatalf("SendLogEvent: %v", err)
	}

	select {
	case m := <-logSeen:
		if m["serviceId"] != "svc-e2e" {
			t.Fatalf("serviceId: %v", m["serviceId"])
		}
	case <-time.After(4 * time.Second):
		t.Fatal("timeout waiting for log_event on server")
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
			t.Fatalf("RunContext: %v", err)
		}
	case <-time.After(2 * time.Second):
	}
}
