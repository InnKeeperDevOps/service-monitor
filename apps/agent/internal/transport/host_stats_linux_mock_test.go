//go:build linux

package transport_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/service-monitor/agent/internal/hoststats"
	"github.com/service-monitor/agent/internal/mockrealtime"
	"github.com/service-monitor/agent/internal/transport"
)

// TestClient_MockRealtime_receivesLiveHostStats ensures the real Linux hoststats sampler produces
// frames the mock server receives (validates end-to-end wiring with /proc-based metrics).
func TestClient_MockRealtime_receivesLiveHostStats(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var msgTypes []string
	var hostStatsPayloads [][]byte

	onAgent := func(typ string, raw []byte) {
		mu.Lock()
		msgTypes = append(msgTypes, typ)
		if typ == "host_stats" {
			hostStatsPayloads = append(hostStatsPayloads, append([]byte(nil), raw...))
		}
		mu.Unlock()
	}

	sampler := hoststats.NewSampler()

	ms := mockrealtime.NewServer(mockrealtime.Config{
		Path:           "/realtime",
		Hello:          mockrealtime.DefaultHello(),
		OnAgentMessage: onAgent,
		Logf:           func(string, ...interface{}) {},
	})
	srv := httptest.NewServer(ms)
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	c := transport.NewClient(u, "agent-live-stats",
		transport.WithCommandHandler(noopHandler{}),
		transport.WithHeartbeatInterval(120*time.Millisecond),
		transport.WithHostStatsCollector(sampler.Build),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- c.RunContext(ctx) }()

	deadline := time.After(2 * time.Second)
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()

wait:
	for {
		mu.Lock()
		n := len(hostStatsPayloads)
		mu.Unlock()
		if n >= 2 {
			// Second sample should include cpuPercent / net rates after baseline (see hoststats.Sampler).
			break wait
		}
		select {
		case <-deadline:
			mu.Lock()
			got := append([]string(nil), msgTypes...)
			nPayloads := len(hostStatsPayloads)
			mu.Unlock()
			t.Fatalf("timeout waiting for 2+ host_stats; types=%v payloads=%d", got, nPayloads)
		case err := <-errCh:
			if err != context.DeadlineExceeded {
				t.Fatalf("RunContext: %v", err)
			}
			mu.Lock()
			got := append([]string(nil), msgTypes...)
			mu.Unlock()
			t.Fatalf("client exited early: %v types=%v", err, got)
		case <-tick.C:
		}
	}

	cancel()
	<-errCh

	mu.Lock()
	payloads := append([][]byte(nil), hostStatsPayloads...)
	mu.Unlock()

	var sawMem, sawDisk bool
	for _, p := range payloads {
		var m map[string]interface{}
		if err := json.Unmarshal(p, &m); err != nil {
			t.Fatalf("host_stats JSON: %v", err)
		}
		if m["type"] != "host_stats" || m["agentId"] != "agent-live-stats" {
			t.Fatalf("unexpected frame: %#v", m)
		}
		if _, ok := m["memTotalBytes"]; ok {
			sawMem = true
		}
		if _, ok := m["diskTotalBytes"]; ok {
			sawDisk = true
		}
	}
	if !sawMem || !sawDisk {
		t.Fatalf("expected mem and disk fields in at least one host_stats; payloads=%d", len(payloads))
	}

	var sawCPUOrNet bool
	for _, p := range payloads {
		var m map[string]interface{}
		_ = json.Unmarshal(p, &m)
		if _, ok := m["cpuPercent"]; ok {
			sawCPUOrNet = true
			break
		}
		if _, ok := m["netRxBytesPerSec"]; ok {
			sawCPUOrNet = true
			break
		}
		if _, ok := m["netTxBytesPerSec"]; ok {
			sawCPUOrNet = true
			break
		}
	}
	if !sawCPUOrNet {
		t.Fatalf("expected cpuPercent or network rates after second sample; got %d payloads", len(payloads))
	}
}
