package executor

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/service-monitor/agent/internal/docker"
)

func TestRunShellHelper(t *testing.T) {
	out, err := RunShell("echo hello-exec")
	if err != nil || !strings.Contains(out, "hello-exec") {
		t.Fatalf("RunShell = %q, %v", out, err)
	}
	if _, err := RunShell("exit 3"); err == nil {
		t.Fatal("expected error for non-zero exit")
	}
}

func TestPlanAndBinaryHelpers(t *testing.T) {
	if a := planArgs("cursor", "p", "/w"); a[0] != "--prompt" || a[3] != "/w" {
		t.Fatalf("planArgs cursor = %v", a)
	}
	if a := planArgs("claude", "p", "/w"); a[2] != "--cwd" {
		t.Fatalf("planArgs claude = %v", a)
	}
	if planBinary("cursor") != "cursor" || planBinary("claude") != "claude" {
		t.Fatal("planBinary defaults")
	}
	os.Setenv("SM_CURSOR_BIN", "/x/cursor")
	if planBinary("cursor") != "/x/cursor" {
		t.Fatal("planBinary env override")
	}
	os.Unsetenv("SM_CURSOR_BIN")
	if dockerBinary() != "docker" {
		t.Fatal("dockerBinary default")
	}
	if containerIsolationEnabled("claude") {
		t.Fatal("isolation should default off")
	}
	os.Setenv("SM_EXECUTOR_ISOLATE_CONTAINERS", "1")
	if !containerIsolationEnabled("claude") {
		t.Fatal("isolation should be on")
	}
	os.Unsetenv("SM_EXECUTOR_ISOLATE_CONTAINERS")
	_ = runnerImage("claude")
	_ = planTimeout()
}

func TestPayloadHelpers(t *testing.T) {
	m := payloadStringMap(map[string]interface{}{"a": "x", "n": 1})
	if m["a"] != "x" || len(m) != 1 {
		t.Fatalf("payloadStringMap = %v", m)
	}
	if len(payloadStringMap("notamap")) != 0 {
		t.Fatal("payloadStringMap non-map")
	}
	if stringValue("s") != "s" || stringValue(42) != "" {
		t.Fatal("stringValue")
	}
	p := map[string]interface{}{"f": float64(5), "i": 7, "i64": int64(9)}
	if intFromPayload(p, "f") != 5 || intFromPayload(p, "i") != 7 || intFromPayload(p, "i64") != 9 {
		t.Fatal("intFromPayload numeric")
	}
	if intFromPayload(p, "missing") != 0 {
		t.Fatal("intFromPayload missing → 0")
	}
}

func TestArtifactHelpers(t *testing.T) {
	if artifactMaxBytes() <= 0 || artifactFetchTimeout() <= 0 {
		t.Fatal("artifact limits")
	}
	if err := validateArtifactURL("https://h/x.tgz"); err != nil {
		t.Fatalf("https should pass: %v", err)
	}
	if validateArtifactURL("http://h/x") == nil && !allowHTTPArtifactURLs() {
		t.Fatal("http should be blocked by default")
	}
	os.Setenv("SM_ARTIFACT_ALLOW_HTTP", "1")
	if err := validateArtifactURL("http://h/x"); err != nil {
		t.Fatalf("http allowed: %v", err)
	}
	os.Unsetenv("SM_ARTIFACT_ALLOW_HTTP")
	if validateArtifactURL("ftp://h/x") == nil {
		t.Fatal("ftp scheme should error")
	}
	if validateArtifactURL("://bad") == nil {
		t.Fatal("unparseable url should error")
	}
}

func TestTarPathHelpers(t *testing.T) {
	if got := stripTarMemberName("/a/b/c", 1); got != "b/c" {
		t.Fatalf("stripTarMemberName = %q", got)
	}
	if stripTarMemberName("a", 5) != "" || stripTarMemberName("  ", 0) != "" {
		t.Fatal("stripTarMemberName edge cases")
	}
	if err := pathWithinDest("/dest", "sub/file"); err != nil {
		t.Fatalf("within dest: %v", err)
	}
	if pathWithinDest("/dest", "../escape") == nil {
		t.Fatal("escape should be rejected")
	}
}

func TestTruncateForLog(t *testing.T) {
	if truncateForLog("a\nb", 100) != "a ⏎ b" {
		t.Fatal("truncateForLog newline replace")
	}
	if !strings.HasSuffix(truncateForLog(strings.Repeat("x", 50), 10), "…") {
		t.Fatal("truncateForLog cap")
	}
}

func TestNewExecutorAndWorkspace(t *testing.T) {
	if NewExecutor(docker.NewClient("/nonexistent.sock")) == nil {
		t.Fatal("NewExecutor nil")
	}
	ws, err := ensureWorkspace(t.TempDir())
	if err != nil || ws == "" {
		t.Fatalf("ensureWorkspace = %q, %v", ws, err)
	}
}

func TestExecuteDispatch(t *testing.T) {
	e := NewExecutor(docker.NewClient("/nonexistent.sock"))
	ctx := context.Background()
	cases := []struct {
		cmd     string
		payload map[string]interface{}
	}{
		{"run_step", map[string]interface{}{"shell": "echo ok"}},
		{"run_step", map[string]interface{}{}}, // missing shell → error branch
		{"cancel_run", map[string]interface{}{}},
		{"sync_desired_state", map[string]interface{}{"desiredContainers": []interface{}{}}},
		{"sync_desired_state", map[string]interface{}{}}, // missing → error branch
		{"run_cursor_plan", map[string]interface{}{"prompt": "p", "executorId": "cursor"}},
		{"run_claude_plan", map[string]interface{}{"prompt": "p"}},
		{"run_fix_plan", map[string]interface{}{"prompt": "p"}},
		{"docker_op", map[string]interface{}{"op": "ps"}},
		{"receive_source_archive", map[string]interface{}{"url": "ftp://bad/x"}},
		{"run_toolchain", map[string]interface{}{}},
		{"redeploy_service", map[string]interface{}{}},
		{"teardown_service", map[string]interface{}{}},
		{"totally_unknown", map[string]interface{}{}},
	}
	for _, c := range cases {
		r := e.Execute(ctx, c.cmd, c.payload)
		// Every dispatch path must return a structured result, never panic.
		_ = r.Success
		_ = r.Output
	}
	if ok, _ := e.HandleCommand(ctx, "run_step", map[string]interface{}{"shell": "echo hi"}); !ok {
		t.Fatal("HandleCommand run_step should succeed")
	}
	if ok, _ := e.HandleCommand(ctx, "totally_unknown", map[string]interface{}{}); ok {
		t.Fatal("HandleCommand unknown should fail")
	}
}
