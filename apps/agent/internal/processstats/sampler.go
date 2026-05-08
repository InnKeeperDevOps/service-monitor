// Package processstats samples host-process telemetry for workloads the agent manages
// by command-line pattern (as declared via sync_desired_state.desiredProcesses). It emits
// one Kaiad realtime `app_stats` frame per matching process, using `containerId = "proc-<pid>"`
// so the existing UI surfaces host processes alongside containers.
package processstats

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/managed"
)

type prevSample struct {
	at         time.Time
	cpuTicks   uint64
	totalTicks uint64
}

// Sampler enumerates /proc, matches cmdlines against the managed inventory,
// and produces `app_stats` frames for each running managed process.
type Sampler struct {
	inventory *managed.Inventory

	mu   sync.Mutex
	last map[int]prevSample // keyed by pid

	clockTicks uint64
	pageSize   uint64
}

func NewSampler(inv *managed.Inventory) *Sampler {
	return &Sampler{
		inventory:  inv,
		last:       map[int]prevSample{},
		clockTicks: 100,
		pageSize:   uint64(os.Getpagesize()),
	}
}

// Build returns zero or more `app_stats` frames, one per managed process. Runs only on Linux hosts
// (no-ops elsewhere since /proc is absent).
func (s *Sampler) Build(agentID string) ([][]byte, error) {
	if s.inventory == nil {
		return nil, nil
	}
	if len(s.inventory.DesiredProcesses()) == 0 {
		return nil, nil
	}

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, nil
	}

	totalTicks, _ := readTotalCPUTicks()

	frames := make([][]byte, 0)
	live := make(map[int]struct{})
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		cmdline, ok := readCmdline(pid)
		if !ok || cmdline == "" {
			continue
		}
		sid := s.inventory.MatchProcess(cmdline)
		if sid == "" {
			continue
		}
		frame := s.buildOne(agentID, pid, cmdline, sid, totalTicks)
		if frame != nil {
			frames = append(frames, frame)
			live[pid] = struct{}{}
		}
	}

	s.mu.Lock()
	for pid := range s.last {
		if _, ok := live[pid]; !ok {
			delete(s.last, pid)
		}
	}
	s.mu.Unlock()

	return frames, nil
}

func (s *Sampler) buildOne(agentID string, pid int, cmdline, serviceID string, totalTicks uint64) []byte {
	cpuTicks, ok := readProcessCPUTicks(pid)
	if !ok {
		return nil
	}
	rssBytes, _ := readProcessRSSBytes(pid, s.pageSize)

	msg := map[string]interface{}{
		"type":        "app_stats",
		"agentId":     agentID,
		"ts":          time.Now().UTC().Format(time.RFC3339Nano),
		"containerId": fmt.Sprintf("proc-%d", pid),
		"name":        trimCmdline(cmdline, 120),
		"image":       "process",
		"state":       "running",
		"serviceId":   serviceID,
	}
	if rssBytes > 0 {
		msg["memUsedBytes"] = rssBytes
	}

	now := time.Now()
	s.mu.Lock()
	prev, hasPrev := s.last[pid]
	if hasPrev && totalTicks > prev.totalTicks {
		cpuDelta := float64(cpuTicks - prev.cpuTicks)
		totalDelta := float64(totalTicks - prev.totalTicks)
		if totalDelta > 0 {
			msg["cpuPercent"] = (cpuDelta / totalDelta) * 100.0
		}
	}
	s.last[pid] = prevSample{at: now, cpuTicks: cpuTicks, totalTicks: totalTicks}
	s.mu.Unlock()

	payload, err := json.Marshal(msg)
	if err != nil {
		return nil
	}
	return payload
}

func readCmdline(pid int) (string, bool) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return "", false
	}
	if len(data) == 0 {
		return "", false
	}
	return strings.TrimRight(strings.ReplaceAll(string(data), "\x00", " "), " "), true
}

func readProcessCPUTicks(pid int) (uint64, bool) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, false
	}
	// /proc/<pid>/stat: last occurrence of ')' ends comm; fields after that are space-separated.
	end := strings.LastIndex(string(data), ")")
	if end < 0 || end+2 >= len(data) {
		return 0, false
	}
	rest := strings.Fields(string(data)[end+2:])
	// fields after comm start at index 0 here == stat field 3 (state). utime=13, stime=14 overall, i.e. indices 11, 12 in rest.
	if len(rest) < 13 {
		return 0, false
	}
	utime, err1 := strconv.ParseUint(rest[11], 10, 64)
	stime, err2 := strconv.ParseUint(rest[12], 10, 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return utime + stime, true
}

func readProcessRSSBytes(pid int, pageSize uint64) (uint64, bool) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "statm"))
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0, false
	}
	rssPages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return rssPages * pageSize, true
}

func readTotalCPUTicks() (uint64, bool) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		var total uint64
		for _, f := range fields[1:] {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				continue
			}
			total += v
		}
		return total, true
	}
	return 0, false
}

func trimCmdline(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
