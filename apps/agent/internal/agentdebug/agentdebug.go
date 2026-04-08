// Package agentdebug gates verbose agent diagnostics behind SM_AGENT_DEBUG.
package agentdebug

import (
	"os"
	"strings"
)

// Enabled reports whether SM_AGENT_DEBUG is set to a truthy value (1, true, yes).
func Enabled() bool {
	v := strings.TrimSpace(os.Getenv("SM_AGENT_DEBUG"))
	if v == "" {
		return false
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
