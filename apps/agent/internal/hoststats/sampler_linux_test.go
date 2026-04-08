//go:build linux

package hoststats

import (
	"testing"
)

func TestSampler_Build_smoke(t *testing.T) {
	s := NewSampler()
	b, err := s.Build("test-agent")
	if err != nil {
		t.Fatal(err)
	}
	if len(b) == 0 {
		t.Fatal("expected non-empty host_stats JSON on Linux")
	}
	if len(b) < 20 {
		t.Fatalf("unexpected payload: %q", b)
	}
}
