package logfile

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

type noopSender struct{}

func (noopSender) SendLogEvent(_, _, _, _ string) error { return nil }

func TestClassifyLogLevel(t *testing.T) {
	errs := []string{"boom ERROR happened", "a FATAL crash", "got Exception here", "Traceback (most recent call last)"}
	for _, l := range errs {
		if got := classifyLogLevel(l); got != "error" {
			t.Fatalf("classifyLogLevel(%q) = %q, want error", l, got)
		}
	}
	infos := []string{"all good", "", "request handled in 3ms"}
	for _, l := range infos {
		if got := classifyLogLevel(l); got != "info" {
			t.Fatalf("classifyLogLevel(%q) = %q, want info", l, got)
		}
	}
}

func TestTailerLifecycle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "svc.log")
	if err := os.WriteFile(path, []byte("starting up\nboom ERROR failed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tr := New(noopSender{})
	if err := tr.Add("svc-1", path, "agent-1"); err != nil {
		t.Fatalf("Add: %v", err)
	}
	// Re-adding the same service is a no-op / replace; exercise it.
	_ = tr.Add("svc-1", path, "agent-1")
	time.Sleep(150 * time.Millisecond)
	tr.Remove("svc-1")
	tr.Remove("does-not-exist")
	tr.Close()
}
