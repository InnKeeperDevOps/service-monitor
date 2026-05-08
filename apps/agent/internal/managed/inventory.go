// Package managed tracks the set of containers / deployments the Kaiad agent owns.
// Telemetry samplers consult it so they only emit stats for apps the agent manages
// (from sync_desired_state), not every process or container running on the host.
package managed

import (
	"strings"
	"sync"

	"github.com/service-monitor/agent/internal/docker"
)

// DesiredContainer mirrors an entry from the sync_desired_state command payload.
type DesiredContainer struct {
	ServiceID string
	Image     string
	State     string
}

// DesiredProcess mirrors a host-process entry from the sync_desired_state payload.
// CommandPattern is a substring matched against /proc/<pid>/cmdline to identify a managed process.
// When Command is set and State is "running" and no process matches CommandPattern,
// the agent's shell supervisor starts it. Stdout/stderr go to LogPath (default
// /tmp/sm-agent/<ServiceID>.log) and the file is tailed for app_log_error shipping.
type DesiredProcess struct {
	ServiceID      string
	CommandPattern string
	State          string
	Command        string
	LogPath        string
	Cwd            string
}

// Inventory is a thread-safe set of managed workloads keyed by serviceId.
type Inventory struct {
	mu         sync.RWMutex
	desired    map[string]DesiredContainer
	processes  map[string]DesiredProcess
}

func New() *Inventory {
	return &Inventory{desired: map[string]DesiredContainer{}, processes: map[string]DesiredProcess{}}
}

// ReplaceDesired swaps in the full desired-container set from a sync_desired_state payload.
func (i *Inventory) ReplaceDesired(list []DesiredContainer) {
	next := make(map[string]DesiredContainer, len(list))
	for _, d := range list {
		if d.ServiceID == "" {
			continue
		}
		next[d.ServiceID] = d
	}
	i.mu.Lock()
	i.desired = next
	i.mu.Unlock()
}

// Desired returns a snapshot of the current desired entries.
func (i *Inventory) Desired() []DesiredContainer {
	i.mu.RLock()
	defer i.mu.RUnlock()
	out := make([]DesiredContainer, 0, len(i.desired))
	for _, d := range i.desired {
		out = append(out, d)
	}
	return out
}

// HasAny reports whether the inventory has been populated (containers or processes).
func (i *Inventory) HasAny() bool {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return len(i.desired) > 0 || len(i.processes) > 0
}

// ReplaceDesiredProcesses swaps in the full desired-process set from a sync_desired_state payload.
func (i *Inventory) ReplaceDesiredProcesses(list []DesiredProcess) {
	next := make(map[string]DesiredProcess, len(list))
	for _, d := range list {
		if d.ServiceID == "" || d.CommandPattern == "" {
			continue
		}
		next[d.ServiceID] = d
	}
	i.mu.Lock()
	i.processes = next
	i.mu.Unlock()
}

// DesiredProcesses returns a snapshot of the current managed process entries.
func (i *Inventory) DesiredProcesses() []DesiredProcess {
	i.mu.RLock()
	defer i.mu.RUnlock()
	out := make([]DesiredProcess, 0, len(i.processes))
	for _, d := range i.processes {
		out = append(out, d)
	}
	return out
}

// MatchProcess returns the serviceId for a cmdline matching a desired process, or "" if unmanaged.
// A process matches when its cmdline (spaces-joined argv) contains the desired CommandPattern as a substring.
func (i *Inventory) MatchProcess(cmdline string) string {
	if cmdline == "" {
		return ""
	}
	i.mu.RLock()
	defer i.mu.RUnlock()
	for sid, d := range i.processes {
		if d.CommandPattern != "" && strings.Contains(cmdline, d.CommandPattern) {
			return sid
		}
	}
	return ""
}

// Match returns the serviceId for a container that matches a desired entry, or "" if unmanaged.
// Matching: image base (without tag/digest) equal, or container name contains the serviceId.
func (i *Inventory) Match(c docker.ContainerInfo) string {
	i.mu.RLock()
	defer i.mu.RUnlock()
	for sid, d := range i.desired {
		if d.Image != "" && imageBasesMatch(c.Image, d.Image) {
			return sid
		}
	}
	for _, n := range c.Names {
		name := strings.TrimPrefix(n, "/")
		for sid := range i.desired {
			if sid != "" && strings.Contains(name, sid) {
				return sid
			}
		}
	}
	return ""
}

func imageBasesMatch(actual, desired string) bool {
	if actual == "" || desired == "" {
		return false
	}
	if actual == desired {
		return true
	}
	return stripTagDigest(actual) == stripTagDigest(desired)
}

func stripTagDigest(image string) string {
	s := strings.SplitN(image, "@", 2)[0]
	// Only strip the last colon segment if it does not contain a slash (registry port vs. tag).
	if idx := strings.LastIndex(s, ":"); idx >= 0 {
		if !strings.Contains(s[idx:], "/") {
			s = s[:idx]
		}
	}
	return s
}
