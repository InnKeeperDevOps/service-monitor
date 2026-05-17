package appstats

import (
	"testing"

	"github.com/service-monitor/agent/internal/docker"
	"github.com/service-monitor/agent/internal/managed"
)

func TestComputeCPUPercent(t *testing.T) {
	var st docker.ContainerStats
	st.CPUStats.CPUUsage.TotalUsage = 200
	st.PreCPUStats.CPUUsage.TotalUsage = 100
	st.CPUStats.SystemCPUUsage = 2000
	st.PreCPUStats.SystemCPUUsage = 1000
	st.CPUStats.OnlineCPUs = 2
	pct, ok := computeCPUPercent(&st)
	if !ok || pct <= 0 {
		t.Fatalf("computeCPUPercent = %v, %v; want >0,true", pct, ok)
	}
	// Non-positive deltas → not ok.
	if _, ok := computeCPUPercent(&docker.ContainerStats{}); ok {
		t.Fatal("expected ok=false for zero deltas")
	}
	// OnlineCPUs==0 falls back to 1.
	st.CPUStats.OnlineCPUs = 0
	if _, ok := computeCPUPercent(&st); !ok {
		t.Fatal("expected ok=true with OnlineCPUs=0 fallback")
	}
}

func TestSumNetworks(t *testing.T) {
	rx, tx := sumNetworks(map[string]docker.ContainerStatsNetwork{
		"eth0": {RxBytes: 10, TxBytes: 5},
		"eth1": {RxBytes: 7, TxBytes: 3},
	})
	if rx != 17 || tx != 8 {
		t.Fatalf("sumNetworks = %d,%d; want 17,8", rx, tx)
	}
	if rx, tx := sumNetworks(nil); rx != 0 || tx != 0 {
		t.Fatalf("sumNetworks(nil) = %d,%d", rx, tx)
	}
}

func TestDisplayName(t *testing.T) {
	if got := displayName(docker.ContainerInfo{Names: []string{"/svc"}}); got != "svc" {
		t.Fatalf("displayName = %q, want svc", got)
	}
	if got := displayName(docker.ContainerInfo{}); got != "" {
		t.Fatalf("displayName(empty) = %q", got)
	}
}

func TestNewSampler(t *testing.T) {
	s := NewSampler(docker.NewClient("/nonexistent.sock"), Options{
		Inventory:  managed.New(),
		GetBackend: func() string { return "docker" },
	})
	if s == nil {
		t.Fatal("NewSampler returned nil")
	}
}
