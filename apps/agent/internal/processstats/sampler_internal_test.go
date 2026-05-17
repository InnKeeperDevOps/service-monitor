//go:build linux

package processstats

import (
	"testing"

	"github.com/service-monitor/agent/internal/managed"
)

func TestTrimCmdline(t *testing.T) {
	if got := trimCmdline("short", 10); got != "short" {
		t.Fatalf("trimCmdline short = %q", got)
	}
	if got := trimCmdline("abcdefgh", 3); got != "abc" {
		t.Fatalf("trimCmdline truncate = %q, want abc", got)
	}
}

func TestReadTotalCPUTicks(t *testing.T) {
	// Linux test runner has /proc/stat; just exercise the reader.
	if _, ok := readTotalCPUTicks(); !ok {
		t.Fatal("readTotalCPUTicks: expected ok on Linux")
	}
}

func TestBuildEmptyInventory(t *testing.T) {
	s := NewSampler(managed.New())
	b, err := s.Build("agent-1")
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	// No managed processes → no per-process payloads.
	if len(b) != 0 {
		t.Fatalf("expected empty build, got %d payloads", len(b))
	}
}
