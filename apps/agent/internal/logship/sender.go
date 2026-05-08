// Package logship buffers recent log lines per service and emits an
// app_log_error realtime frame whenever an error-level line is observed.
// The frame includes the last N lines of context so the platform can
// fingerprint and act on the error without a separate log lookup.
package logship

import (
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/docker"
)

// ErrorFrameSender writes an `app_log_error` frame to the realtime channel.
// The transport.Client implements this in addition to docker.LogSender.
type ErrorFrameSender interface {
	SendAppLogError(agentID, serviceID, message string, contextLines []string, ts string) error
}

type ringBuffer struct {
	lines []string
	head  int
	full  bool
}

func newRing(capacity int) *ringBuffer {
	if capacity <= 0 {
		capacity = 1
	}
	return &ringBuffer{lines: make([]string, capacity)}
}

func (r *ringBuffer) push(line string) {
	r.lines[r.head] = line
	r.head++
	if r.head >= len(r.lines) {
		r.head = 0
		r.full = true
	}
}

func (r *ringBuffer) snapshot() []string {
	if !r.full {
		out := make([]string, r.head)
		copy(out, r.lines[:r.head])
		return out
	}
	out := make([]string, len(r.lines))
	n := copy(out, r.lines[r.head:])
	copy(out[n:], r.lines[:r.head])
	return out
}

// Sender wraps a docker.LogSender. It records every line in a per-service
// ring buffer and, on error/fatal, emits an `app_log_error` frame carrying
// the last `capacity` lines of context.
type Sender struct {
	inner     docker.LogSender
	errSender ErrorFrameSender
	capacity  int
	mu        sync.Mutex
	buffers   map[string]*ringBuffer
}

// NewSender constructs a buffering log sender. Capacity is the number of
// context lines kept per service (50 in production). When errSender is nil,
// only the wrapped log_event flow runs (back-compat with hosts that have not
// yet upgraded the platform).
func NewSender(inner docker.LogSender, errSender ErrorFrameSender, capacity int) *Sender {
	return &Sender{
		inner:     inner,
		errSender: errSender,
		capacity:  capacity,
		buffers:   make(map[string]*ringBuffer),
	}
}

func (s *Sender) bufferFor(serviceID string) *ringBuffer {
	rb, ok := s.buffers[serviceID]
	if !ok {
		rb = newRing(s.capacity)
		s.buffers[serviceID] = rb
	}
	return rb
}

// SendLogEvent satisfies docker.LogSender. It records the line in the buffer
// for `serviceID`, emits an `app_log_error` frame on error-level lines, and
// then forwards the line to the wrapped sender so the existing log_event
// pipeline is unchanged.
func (s *Sender) SendLogEvent(agentID, serviceID, level, message string) error {
	s.mu.Lock()
	s.bufferFor(serviceID).push(message)
	var ctx []string
	if level == "error" || level == "fatal" {
		ctx = s.bufferFor(serviceID).snapshot()
	}
	s.mu.Unlock()

	if ctx != nil && s.errSender != nil {
		_ = s.errSender.SendAppLogError(agentID, serviceID, message, ctx, time.Now().UTC().Format(time.RFC3339Nano))
	}
	if s.inner == nil {
		return nil
	}
	return s.inner.SendLogEvent(agentID, serviceID, level, message)
}
