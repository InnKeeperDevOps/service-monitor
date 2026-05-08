package transport_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/service-monitor/agent/internal/transport"
)

// rejectingServer accepts the WS upgrade, sends one apiError-shaped frame,
// then closes — mirrors what the Kaiad API does when /realtime sees an
// invalid enrollment token. Used to prove the client surfaces the rejection
// AND bails out instead of retrying forever.
func rejectingServer(t *testing.T, code, message string) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade: %v", err)
			return
		}
		// {code, message} — no `type` field, mirroring server.ts.
		_ = conn.WriteJSON(map[string]string{
			"code":    code,
			"message": message,
		})
		_ = conn.Close()
	}))
}

func TestClient_PermanentRejection_INVALID_TOKEN(t *testing.T) {
	t.Parallel()
	srv := rejectingServer(t, "INVALID_TOKEN", "Invalid or expired enrollment token")
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c := transport.NewClient(u, "agent-rejection",
		transport.WithCommandHandler(noopHandler{}),
		transport.WithHeartbeatInterval(50*time.Millisecond),
		transport.WithReconnectBackoff(10*time.Millisecond, 50*time.Millisecond),
	)
	err := c.RunContext(ctx)

	// RunContext should return ErrPermanentRejection and stop the loop —
	// not hang until ctx deadline like a normal disconnect would.
	if !errors.Is(err, transport.ErrPermanentRejection) {
		t.Fatalf("expected ErrPermanentRejection, got %v", err)
	}
}

func TestClient_PermanentRejection_UNAUTHORIZED(t *testing.T) {
	t.Parallel()
	srv := rejectingServer(t, "UNAUTHORIZED", "missing scope")
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c := transport.NewClient(u, "agent-rejection",
		transport.WithCommandHandler(noopHandler{}),
		transport.WithHeartbeatInterval(50*time.Millisecond),
		transport.WithReconnectBackoff(10*time.Millisecond, 50*time.Millisecond),
	)
	err := c.RunContext(ctx)
	if !errors.Is(err, transport.ErrPermanentRejection) {
		t.Fatalf("expected ErrPermanentRejection, got %v", err)
	}
}

func TestClient_TransientRejection_DoesNotExit(t *testing.T) {
	t.Parallel()
	// ENROLLMENT_STORE_UNAVAILABLE is intentionally NOT in the permanent
	// list — a control-plane outage shouldn't crash the agent. Instead we
	// expect the client to keep reconnecting until ctx times out.
	srv := rejectingServer(t, "ENROLLMENT_STORE_UNAVAILABLE", "db down")
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	c := transport.NewClient(u, "agent-rejection",
		transport.WithCommandHandler(noopHandler{}),
		transport.WithHeartbeatInterval(50*time.Millisecond),
		transport.WithReconnectBackoff(10*time.Millisecond, 50*time.Millisecond),
	)
	err := c.RunContext(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded (client keeps retrying), got %v", err)
	}
}
