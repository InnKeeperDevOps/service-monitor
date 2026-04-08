package transport_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/service-monitor/agent/internal/mockrealtime"
	"github.com/service-monitor/agent/internal/transport"
)

// TestClient_MockRealtime_receivesHostStats ensures the mock server observes host_stats frames when
// WithHostStatsCollector is wired (portable: uses a deterministic fake payload, not OS metrics).
func TestClient_MockRealtime_receivesHostStats(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var msgTypes []string
	var lastHostStats []byte

	onAgent := func(typ string, raw []byte) {
		mu.Lock()
		msgTypes = append(msgTypes, typ)
		if typ == "host_stats" {
			lastHostStats = append([]byte(nil), raw...)
		}
		mu.Unlock()
	}

	fakeHostStats := func(agentID string) ([]byte, error) {
		return json.Marshal(map[string]interface{}{
			"type":          "host_stats",
			"agentId":       agentID,
			"ts":            time.Now().UTC().Format(time.RFC3339Nano),
			"cpuPercent":    42.5,
			"memTotalBytes": 999_999,
		})
	}

	ms := mockrealtime.NewServer(mockrealtime.Config{
		Path:           "/realtime",
		Hello:          mockrealtime.DefaultHello(),
		OnAgentMessage: onAgent,
		Logf:           func(string, ...interface{}) {},
	})
	srv := httptest.NewServer(ms)
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	c := transport.NewClient(u, "agent-hs-mock",
		transport.WithCommandHandler(noopHandler{}),
		transport.WithHeartbeatInterval(40*time.Millisecond),
		transport.WithHostStatsCollector(fakeHostStats),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- c.RunContext(ctx) }()

	deadline := time.After(1500 * time.Millisecond)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()

wait:
	for {
		mu.Lock()
		has := false
		for _, typ := range msgTypes {
			if typ == "host_stats" {
				has = true
				break
			}
		}
		mu.Unlock()
		if has {
			break wait
		}
		select {
		case <-deadline:
			mu.Lock()
			got := append([]string(nil), msgTypes...)
			mu.Unlock()
			t.Fatalf("timeout waiting for host_stats; mock saw types=%v", got)
		case err := <-errCh:
			if err != context.DeadlineExceeded {
				t.Fatalf("RunContext: %v", err)
			}
			mu.Lock()
			got := append([]string(nil), msgTypes...)
			mu.Unlock()
			t.Fatalf("client exited before host_stats; err=%v types=%v", err, got)
		case <-tick.C:
		}
	}

	cancel()
	<-errCh

	mu.Lock()
	payload := append([]byte(nil), lastHostStats...)
	mu.Unlock()
	if len(payload) == 0 {
		t.Fatal("expected captured host_stats JSON")
	}
	var m map[string]interface{}
	if err := json.Unmarshal(payload, &m); err != nil {
		t.Fatalf("host_stats JSON: %v", err)
	}
	if m["type"] != "host_stats" {
		t.Fatalf("type: got %v", m["type"])
	}
	if m["agentId"] != "agent-hs-mock" {
		t.Fatalf("agentId: got %v", m["agentId"])
	}
	if m["cpuPercent"] != 42.5 {
		t.Fatalf("cpuPercent: got %v", m["cpuPercent"])
	}
	if int64(m["memTotalBytes"].(float64)) != 999999 {
		t.Fatalf("memTotalBytes: got %v", m["memTotalBytes"])
	}
}
