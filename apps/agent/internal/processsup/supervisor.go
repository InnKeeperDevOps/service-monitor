// Package processsup is a tiny shell-runtime process supervisor used when the
// agent runtime is "shell" (no Docker). On `sync_desired_state`, the supervisor
// reconciles desired processes: start anything that's missing, redirect its
// stdout/stderr into a log file under /tmp/sm-agent, and tail that file
// through a docker.LogSender so error-classified lines fan out as
// app_log_error frames the same way docker-runtime services do.
package processsup

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/service-monitor/agent/internal/docker"
	"github.com/service-monitor/agent/internal/managed"
)

const defaultLogDir = "/tmp/sm-agent"

// Tailer is the small subset of internal/logfile/tailer the supervisor needs.
// We declare it as an interface so the wiring in main.go can swap in a fake
// during unit tests.
type Tailer interface {
	Add(serviceID, logPath, agentID string) error
	Remove(serviceID string)
	Close()
}

// Supervisor reconciles desired processes against running ones. It is
// idempotent: calling Reconcile with the same desired list is a no-op.
type Supervisor struct {
	mu       sync.Mutex
	running  map[string]*runningProc // keyed by serviceID
	tailer   Tailer
	agentID  string
	procFind func(pattern string) (int, error)
}

type runningProc struct {
	pid     int
	logPath string
}

// New creates a supervisor that ships log lines to `tailer` (typically a
// logfile.Tailer wrapping a logship.Sender).
func New(tailer Tailer, agentID string) *Supervisor {
	return &Supervisor{
		running:  map[string]*runningProc{},
		tailer:   tailer,
		agentID:  agentID,
		procFind: findPidByCmdline,
	}
}

// Reconcile starts/stops processes to match `desired`. A process is started
// only when it has Command set + State == "running" + no existing PID matches
// its CommandPattern.
func (s *Supervisor) Reconcile(desired []managed.DesiredProcess) {
	log.Printf("processsup: reconcile called with %d desired processes", len(desired))
	s.mu.Lock()
	defer s.mu.Unlock()

	wanted := map[string]struct{}{}
	for _, d := range desired {
		log.Printf("processsup: reconcile entry serviceID=%s state=%s pattern=%s commandLen=%d", d.ServiceID, d.State, d.CommandPattern, len(d.Command))
		if d.ServiceID == "" {
			continue
		}
		wanted[d.ServiceID] = struct{}{}
		if !strings.EqualFold(d.State, "running") {
			s.stopUnlocked(d.ServiceID)
			continue
		}
		if _, alreadyRunning := s.running[d.ServiceID]; alreadyRunning {
			continue
		}
		if pid, _ := s.procFind(d.CommandPattern); pid > 0 {
			// Some other actor (operator, systemd) already has it running. Don't double-start.
			// We do still register a tailer if a log path is provided.
			if d.LogPath != "" && s.tailer != nil {
				_ = s.tailer.Add(d.ServiceID, d.LogPath, s.agentID)
			}
			s.running[d.ServiceID] = &runningProc{pid: pid, logPath: d.LogPath}
			continue
		}
		if strings.TrimSpace(d.Command) == "" {
			// Nothing we can start; leave alone.
			continue
		}
		logPath := d.LogPath
		if logPath == "" {
			logPath = filepath.Join(defaultLogDir, sanitize(d.ServiceID)+".log")
		}
		if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
			log.Printf("processsup: mkdir %s: %v", filepath.Dir(logPath), err)
			continue
		}
		pid, err := startDetached(d.Command, d.Cwd, logPath)
		if err != nil {
			log.Printf("processsup: start service=%s: %v", d.ServiceID, err)
			continue
		}
		log.Printf("processsup: started service=%s pid=%d log=%s", d.ServiceID, pid, logPath)
		s.running[d.ServiceID] = &runningProc{pid: pid, logPath: logPath}
		if s.tailer != nil {
			if err := s.tailer.Add(d.ServiceID, logPath, s.agentID); err != nil {
				log.Printf("processsup: tailer add service=%s: %v", d.ServiceID, err)
			}
		}
	}

	for sid := range s.running {
		if _, ok := wanted[sid]; !ok {
			s.stopUnlocked(sid)
		}
	}
}

func (s *Supervisor) stopUnlocked(serviceID string) {
	rp, ok := s.running[serviceID]
	if !ok {
		return
	}
	delete(s.running, serviceID)
	if s.tailer != nil {
		s.tailer.Remove(serviceID)
	}
	if rp.pid > 0 {
		// Kill the whole process group so children (e.g. java sub-procs) die too.
		_ = syscall.Kill(-rp.pid, syscall.SIGTERM)
	}
}

// Close stops the tailer; running processes are intentionally left alone so
// they survive an agent restart.
func (s *Supervisor) Close() {
	if s.tailer != nil {
		s.tailer.Close()
	}
}

// startDetached spawns `bash -c <command>` as the leader of a new session,
// redirects stdout/stderr to logPath (append), closes stdin, and disowns. The
// caller gets the PID of the bash wrapper.
func startDetached(command, cwd, logPath string) (int, error) {
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, fmt.Errorf("open log: %w", err)
	}
	defer logFile.Close()

	devnull, err := os.OpenFile(os.DevNull, os.O_RDONLY, 0)
	if err != nil {
		return 0, fmt.Errorf("open devnull: %w", err)
	}
	defer devnull.Close()

	cmd := exec.Command("bash", "-c", command)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Stdin = devnull
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("start: %w", err)
	}
	pid := cmd.Process.Pid
	// Release so the agent doesn't keep the child as a zombie target.
	_ = cmd.Process.Release()
	return pid, nil
}

// findPidByCmdline scans /proc for a process whose cmdline contains `pattern`.
// Returns the first match's pid, or 0 if none.
func findPidByCmdline(pattern string) (int, error) {
	if pattern == "" {
		return 0, nil
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		var pid int
		if _, err := fmt.Sscanf(e.Name(), "%d", &pid); err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		joined := strings.ReplaceAll(string(raw), "\x00", " ")
		if strings.Contains(joined, pattern) {
			return pid, nil
		}
	}
	return 0, nil
}

func sanitize(s string) string {
	r := strings.NewReplacer("/", "_", " ", "_", ":", "_")
	return r.Replace(s)
}

// Compile-time check that the supervisor's tailer interface is satisfied by
// the docker.LogSender expectation when a tailer wraps a sender.
var _ Tailer = (Tailer)(nil)
var _ docker.LogSender = (docker.LogSender)(nil)
