package agentdebug

import (
	"testing"
)

func TestEnabled(t *testing.T) {
	t.Setenv("SM_AGENT_DEBUG", "")
	if Enabled() {
		t.Fatal("expected false when unset")
	}
	t.Setenv("SM_AGENT_DEBUG", "1")
	if !Enabled() {
		t.Fatal("expected true for 1")
	}
	t.Setenv("SM_AGENT_DEBUG", "true")
	if !Enabled() {
		t.Fatal("expected true for true")
	}
	t.Setenv("SM_AGENT_DEBUG", "0")
	if Enabled() {
		t.Fatal("expected false for 0")
	}
}
