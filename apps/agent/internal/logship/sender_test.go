package logship

import (
	"sync"
	"testing"
)

type capturedLog struct {
	agentID, serviceID, level, message string
}

type capturedErr struct {
	agentID, serviceID, message string
	contextLines                []string
}

type fakeInner struct {
	mu   sync.Mutex
	logs []capturedLog
}

func (f *fakeInner) SendLogEvent(agentID, serviceID, level, message string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs = append(f.logs, capturedLog{agentID, serviceID, level, message})
	return nil
}

type fakeErr struct {
	mu   sync.Mutex
	errs []capturedErr
}

func (f *fakeErr) SendAppLogError(agentID, serviceID, message string, contextLines []string, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := append([]string(nil), contextLines...)
	f.errs = append(f.errs, capturedErr{agentID, serviceID, message, cp})
	return nil
}

func TestSenderForwardsAllAndEmitsErrorWithContext(t *testing.T) {
	inner := &fakeInner{}
	errs := &fakeErr{}
	s := NewSender(inner, errs, 5)

	_ = s.SendLogEvent("agent-1", "svc", "info", "starting up")
	_ = s.SendLogEvent("agent-1", "svc", "info", "ready")
	_ = s.SendLogEvent("agent-1", "svc", "info", "request 1")
	_ = s.SendLogEvent("agent-1", "svc", "error", "boom: connection refused")

	if got := len(inner.logs); got != 4 {
		t.Fatalf("inner forwarded %d, want 4", got)
	}
	if got := len(errs.errs); got != 1 {
		t.Fatalf("errors emitted %d, want 1", got)
	}
	got := errs.errs[0]
	if got.message != "boom: connection refused" || got.serviceID != "svc" {
		t.Fatalf("unexpected error frame: %+v", got)
	}
	if len(got.contextLines) != 4 {
		t.Fatalf("context lines = %d, want 4 (incl. error line)", len(got.contextLines))
	}
	if got.contextLines[0] != "starting up" || got.contextLines[3] != "boom: connection refused" {
		t.Fatalf("context order wrong: %v", got.contextLines)
	}
}

func TestSenderRingBufferKeepsOnlyLastN(t *testing.T) {
	inner := &fakeInner{}
	errs := &fakeErr{}
	s := NewSender(inner, errs, 3)

	for i := 0; i < 10; i++ {
		_ = s.SendLogEvent("a", "svc", "info", "line")
	}
	_ = s.SendLogEvent("a", "svc", "error", "fail")

	if got := len(errs.errs[0].contextLines); got != 3 {
		t.Fatalf("context lines = %d, want 3", got)
	}
	if errs.errs[0].contextLines[2] != "fail" {
		t.Fatalf("last context line = %q, want fail", errs.errs[0].contextLines[2])
	}
}

func TestSenderIsolatesPerService(t *testing.T) {
	inner := &fakeInner{}
	errs := &fakeErr{}
	s := NewSender(inner, errs, 5)

	_ = s.SendLogEvent("a", "svcA", "info", "A1")
	_ = s.SendLogEvent("a", "svcB", "info", "B1")
	_ = s.SendLogEvent("a", "svcA", "error", "Aerr")

	if len(errs.errs) != 1 {
		t.Fatalf("expected 1 error frame, got %d", len(errs.errs))
	}
	got := errs.errs[0].contextLines
	for _, line := range got {
		if line == "B1" {
			t.Fatalf("svcA error context leaked svcB line: %v", got)
		}
	}
	if len(got) != 2 || got[0] != "A1" || got[1] != "Aerr" {
		t.Fatalf("svcA context = %v, want [A1 Aerr]", got)
	}
}

func TestSenderFatalAlsoEmits(t *testing.T) {
	inner := &fakeInner{}
	errs := &fakeErr{}
	s := NewSender(inner, errs, 5)
	_ = s.SendLogEvent("a", "svc", "fatal", "crash")
	if len(errs.errs) != 1 {
		t.Fatalf("fatal should emit, got %d", len(errs.errs))
	}
}

func TestSenderTolerantOfNilErrSender(t *testing.T) {
	inner := &fakeInner{}
	s := NewSender(inner, nil, 5)
	if err := s.SendLogEvent("a", "svc", "error", "x"); err != nil {
		t.Fatal(err)
	}
	if len(inner.logs) != 1 {
		t.Fatal("inner should still receive the log_event")
	}
}
