package processsup

import (
	"testing"

	"github.com/service-monitor/agent/internal/managed"
)

type fakeTailer struct{}

func (fakeTailer) Add(_, _, _ string) error { return nil }
func (fakeTailer) Remove(_ string)          {}
func (fakeTailer) Close()                   {}

func TestSanitize(t *testing.T) {
	if got := sanitize("a/b c:d"); got != "a_b_c_d" {
		t.Fatalf("sanitize = %q, want a_b_c_d", got)
	}
	if got := sanitize("plain"); got != "plain" {
		t.Fatalf("sanitize(plain) = %q", got)
	}
}

func TestSupervisorReconcileEmptyAndClose(t *testing.T) {
	s := New(fakeTailer{}, "agent-1")
	// Empty desired sets: exercises the lock + diff + no-op paths and
	// idempotency, without spawning real processes.
	s.Reconcile(nil)
	s.Reconcile([]managed.DesiredProcess{})
	s.Reconcile([]managed.DesiredProcess{})
	s.Close()
}
