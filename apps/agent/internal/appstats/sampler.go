// Package appstats samples Docker container telemetry (CPU/memory/network) and emits
// one Kaiad realtime `app_stats` frame per running container.
package appstats

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/docker"
	"github.com/service-monitor/agent/internal/managed"
)

// Options configures runtime-backend and managed-inventory gating.
type Options struct {
	// GetBackend returns the current runtime backend ("docker", "shell", "kubernetes").
	// Called on each Build to pick up tenant runtime changes signaled by Kaiad's hello.
	GetBackend func() string
	// Inventory is consulted to filter stats to apps the agent manages. Required.
	Inventory *managed.Inventory
}

type prevSample struct {
	at    time.Time
	netRx uint64
	netTx uint64
}

type containerMatch struct {
	info      docker.ContainerInfo
	serviceID string
}

// Sampler lists containers and samples stats for each, deriving network rates from prior samples.
type Sampler struct {
	dc        *docker.Client
	inventory *managed.Inventory
	backendFn func() string

	mu   sync.Mutex
	last map[string]prevSample // keyed by containerId

	sampleTimeout time.Duration
	maxParallel   int
}

// NewSampler builds a sampler backed by the given Docker client.
// opts.GetBackend and opts.Inventory gate which apps are sampled;
// when Inventory is nil or GetBackend reports a non-docker runtime, Build returns no frames.
func NewSampler(dc *docker.Client, opts Options) *Sampler {
	return &Sampler{
		dc:            dc,
		inventory:     opts.Inventory,
		backendFn:     opts.GetBackend,
		last:          make(map[string]prevSample),
		sampleTimeout: 5 * time.Second,
		maxParallel:   4,
	}
}

// Build returns zero or more JSON `app_stats` frames (one per running, managed container).
// Only containers tracked by the agent's managed inventory are reported. Shell and
// Kubernetes runtime backends currently emit no frames (no container model yet).
func (s *Sampler) Build(agentID string) ([][]byte, error) {
	if s.inventory == nil {
		return nil, nil
	}
	if s.backendFn != nil {
		switch strings.ToLower(strings.TrimSpace(s.backendFn())) {
		case "", "docker":
			// fall through to docker sampling
		default:
			return nil, nil
		}
	}
	if !s.inventory.HasAny() {
		// Nothing to report yet — agent has not received a sync_desired_state.
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), s.sampleTimeout)
	defer cancel()

	containers, err := s.dc.ListContainers(ctx)
	if err != nil {
		return nil, err
	}

	running := make([]containerMatch, 0, len(containers))
	for _, c := range containers {
		if !strings.EqualFold(c.State, "running") {
			continue
		}
		sid := s.inventory.Match(c)
		if sid == "" {
			continue
		}
		running = append(running, containerMatch{info: c, serviceID: sid})
	}

	s.evictMissingMatches(running)

	if len(running) == 0 {
		return nil, nil
	}

	results := make([][]byte, len(running))
	errs := make([]error, len(running))
	sem := make(chan struct{}, s.maxParallel)
	var wg sync.WaitGroup
	for i, c := range running {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, m containerMatch) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i], errs[i] = s.buildOne(ctx, agentID, m.info, m.serviceID)
		}(i, c)
	}
	wg.Wait()

	frames := make([][]byte, 0, len(running))
	for i := range running {
		if errs[i] != nil || results[i] == nil {
			continue
		}
		frames = append(frames, results[i])
	}
	return frames, nil
}

func (s *Sampler) evictMissingMatches(running []containerMatch) {
	live := make(map[string]struct{}, len(running))
	for _, c := range running {
		live[c.info.ID] = struct{}{}
	}
	s.mu.Lock()
	for id := range s.last {
		if _, ok := live[id]; !ok {
			delete(s.last, id)
		}
	}
	s.mu.Unlock()
}

func (s *Sampler) buildOne(ctx context.Context, agentID string, c docker.ContainerInfo, serviceID string) ([]byte, error) {
	stats, err := s.dc.ContainerStats(ctx, c.ID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	msg := map[string]interface{}{
		"type":        "app_stats",
		"agentId":     agentID,
		"ts":          now.UTC().Format(time.RFC3339Nano),
		"containerId": c.ID,
	}
	if name := displayName(c); name != "" {
		msg["name"] = name
	}
	if c.Image != "" {
		msg["image"] = c.Image
	}
	if c.State != "" {
		msg["state"] = c.State
	}
	if serviceID != "" {
		msg["serviceId"] = serviceID
	}

	if cpu, ok := computeCPUPercent(stats); ok {
		msg["cpuPercent"] = cpu
	}
	if stats.MemoryStats.Usage > 0 {
		working := stats.MemoryStats.Usage
		if stats.MemoryStats.Stats.Cache > 0 && stats.MemoryStats.Stats.Cache <= working {
			working -= stats.MemoryStats.Stats.Cache
		}
		msg["memUsedBytes"] = working
		if stats.MemoryStats.Limit > 0 {
			msg["memLimitBytes"] = stats.MemoryStats.Limit
			msg["memPercent"] = float64(working) / float64(stats.MemoryStats.Limit) * 100.0
		}
	}

	rx, tx := sumNetworks(stats.Networks)
	s.mu.Lock()
	prev, hasPrev := s.last[c.ID]
	if hasPrev {
		dt := now.Sub(prev.at).Seconds()
		if dt < 1e-3 {
			dt = 1e-3
		}
		if rx >= prev.netRx && tx >= prev.netTx {
			msg["netRxBytesPerSec"] = float64(rx-prev.netRx) / dt
			msg["netTxBytesPerSec"] = float64(tx-prev.netTx) / dt
		}
	}
	s.last[c.ID] = prevSample{at: now, netRx: rx, netTx: tx}
	s.mu.Unlock()

	return json.Marshal(msg)
}

func computeCPUPercent(stats *docker.ContainerStats) (float64, bool) {
	cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage) - float64(stats.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(stats.CPUStats.SystemCPUUsage) - float64(stats.PreCPUStats.SystemCPUUsage)
	if cpuDelta <= 0 || sysDelta <= 0 {
		return 0, false
	}
	cpus := float64(stats.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = 1
	}
	return (cpuDelta / sysDelta) * cpus * 100.0, true
}

func sumNetworks(nets map[string]docker.ContainerStatsNetwork) (rx, tx uint64) {
	for _, n := range nets {
		rx += n.RxBytes
		tx += n.TxBytes
	}
	return rx, tx
}

func displayName(c docker.ContainerInfo) string {
	if len(c.Names) > 0 {
		return strings.TrimPrefix(c.Names[0], "/")
	}
	return ""
}
