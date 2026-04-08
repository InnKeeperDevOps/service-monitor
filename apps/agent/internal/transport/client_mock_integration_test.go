package transport_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/service-monitor/agent/internal/mockrealtime"
	"github.com/service-monitor/agent/internal/transport"
)

type noopHandler struct{}

func (noopHandler) HandleCommand(ctx context.Context, cmdType string, payload map[string]interface{}) (bool, string) {
	return true, "ok"
}

func TestClient_againstMockRealtime(t *testing.T) {
	t.Parallel()
	ms := mockrealtime.NewServer(mockrealtime.Config{
		Path:  "/realtime",
		Hello: mockrealtime.DefaultHello(),
		Logf:  func(string, ...interface{}) {}, // quiet
	})
	srv := httptest.NewServer(ms)
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	c := transport.NewClient(u, "agent-integration", transport.WithCommandHandler(noopHandler{}), transport.WithHeartbeatInterval(50*time.Millisecond))
	err := c.RunContext(ctx)
	if err != context.DeadlineExceeded {
		t.Fatalf("expected deadline stop, got %v", err)
	}
}
