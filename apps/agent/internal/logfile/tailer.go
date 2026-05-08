// Package logfile tails one or more log files and forwards each line to a
// docker.LogSender (typically the logship buffering wrapper) so error-level
// lines get shipped as `app_log_error` frames the same way docker container
// logs do. Used by the shell-runtime supervisor.
package logfile

import (
	"bufio"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/docker"
)

// Tailer manages a set of file tail goroutines.
type Tailer struct {
	mu      sync.Mutex
	active  map[string]chan struct{} // serviceID -> stop channel
	sender  docker.LogSender
	pollDur time.Duration
}

// New constructs a Tailer that forwards lines to `sender`.
func New(sender docker.LogSender) *Tailer {
	return &Tailer{
		active:  map[string]chan struct{}{},
		sender:  sender,
		pollDur: 200 * time.Millisecond,
	}
}

// Add starts a tail goroutine for `path`. Idempotent: a no-op if the same
// serviceID is already tailing.
func (t *Tailer) Add(serviceID, path, agentID string) error {
	t.mu.Lock()
	if _, ok := t.active[serviceID]; ok {
		t.mu.Unlock()
		return nil
	}
	stop := make(chan struct{})
	t.active[serviceID] = stop
	t.mu.Unlock()

	go t.run(stop, serviceID, path, agentID)
	return nil
}

// Remove stops tailing for a serviceID. Safe to call multiple times.
func (t *Tailer) Remove(serviceID string) {
	t.mu.Lock()
	stop, ok := t.active[serviceID]
	if ok {
		delete(t.active, serviceID)
	}
	t.mu.Unlock()
	if ok {
		close(stop)
	}
}

// Close stops all tailers.
func (t *Tailer) Close() {
	t.mu.Lock()
	stops := make([]chan struct{}, 0, len(t.active))
	for _, s := range t.active {
		stops = append(stops, s)
	}
	t.active = map[string]chan struct{}{}
	t.mu.Unlock()
	for _, s := range stops {
		close(s)
	}
}

func (t *Tailer) run(stop <-chan struct{}, serviceID, path, agentID string) {
	// Wait for the file to exist (process may not have started yet).
	for {
		select {
		case <-stop:
			return
		default:
		}
		if _, err := os.Stat(path); err == nil {
			break
		}
		time.Sleep(t.pollDur)
	}

	f, err := os.Open(path)
	if err != nil {
		log.Printf("logfile: open %s: %v", path, err)
		return
	}
	defer f.Close()
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		log.Printf("logfile: seek %s: %v", path, err)
		return
	}

	reader := bufio.NewReader(f)
	var pending strings.Builder
	for {
		select {
		case <-stop:
			return
		default:
		}
		chunk, err := reader.ReadString('\n')
		if len(chunk) > 0 {
			pending.WriteString(chunk)
			if strings.HasSuffix(chunk, "\n") {
				line := strings.TrimRight(pending.String(), "\r\n")
				pending.Reset()
				if line != "" {
					level := classifyLogLevel(line)
					if t.sender != nil {
						_ = t.sender.SendLogEvent(agentID, serviceID, level, line)
					}
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				time.Sleep(t.pollDur)
				continue
			}
			log.Printf("logfile: read %s: %v", path, err)
			return
		}
	}
}

// classifyLogLevel mirrors docker.classifyLogLevel — keep them aligned. We
// don't import the docker version because it's unexported.
func classifyLogLevel(line string) string {
	upper := strings.ToUpper(line)
	for _, kw := range []string{"ERROR", "FATAL", "EXCEPTION", "TRACEBACK"} {
		if strings.Contains(upper, kw) {
			return "error"
		}
	}
	return "info"
}
