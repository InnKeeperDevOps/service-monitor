package docker

import "testing"

func TestClassifyLogLevel_error(t *testing.T) {
	for _, line := range []string{
		"2024-01-01 ERROR something broke",
		"FATAL: cannot connect",
		"java.lang.Exception in thread",
		"Traceback (most recent call last):",
	} {
		if lvl := classifyLogLevel(line); lvl != "error" {
			t.Errorf("expected error for %q, got %s", line, lvl)
		}
	}
}

func TestClassifyLogLevel_info(t *testing.T) {
	for _, line := range []string{
		"server started on port 8080",
		"request handled in 23ms",
	} {
		if lvl := classifyLogLevel(line); lvl != "info" {
			t.Errorf("expected info for %q, got %s", line, lvl)
		}
	}
}
