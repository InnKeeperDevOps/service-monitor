package executor

import (
	"context"
	"os"
	"strings"
	"testing"
)

func newReadyExecutor() *Executor {
	e := NewExecutor(nil)
	e.Configure(nil, RuntimeDocker)
	return e
}

func TestRunShell(t *testing.T) {
	out, err := RunShell("echo ok")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == "" {
		t.Fatal("expected output")
	}
}

func TestExecuteRunStep(t *testing.T) {
	e := newReadyExecutor()
	result := e.Execute(context.Background(), "run_step", map[string]interface{}{
		"shell": "echo hello",
	})
	if !result.Success {
		t.Fatalf("expected success, got failure: %s", result.Output)
	}
	if !strings.Contains(result.Output, "hello") {
		t.Fatalf("expected output to contain 'hello', got: %s", result.Output)
	}
}

func TestExecuteRunStepMissingShell(t *testing.T) {
	e := newReadyExecutor()
	result := e.Execute(context.Background(), "run_step", map[string]interface{}{})
	if result.Success {
		t.Fatal("expected failure for missing shell command")
	}
}

func TestExecuteUnknownType(t *testing.T) {
	e := newReadyExecutor()
	result := e.Execute(context.Background(), "bogus", nil)
	if result.Success {
		t.Fatal("expected failure for unknown command type")
	}
	if !strings.Contains(result.Output, "unknown command type") {
		t.Fatalf("expected 'unknown command type' in output, got: %s", result.Output)
	}
}

func TestExecuteCancelRun(t *testing.T) {
	e := NewExecutor(nil)
	result := e.Execute(context.Background(), "cancel_run", nil)
	if !result.Success {
		t.Fatalf("expected success for cancel_run, got: %s", result.Output)
	}
}

func TestExecuteSyncDesiredState(t *testing.T) {
	e := newReadyExecutor()
	result := e.Execute(context.Background(), "sync_desired_state", map[string]interface{}{
		"desiredContainers": []interface{}{
			map[string]interface{}{"serviceId": "a", "image": "nginx", "state": "running"},
		},
	})
	if !result.Success {
		t.Fatalf("expected success: %s", result.Output)
	}
	if !strings.Contains(result.Output, "1 entries") {
		t.Fatalf("output: %s", result.Output)
	}
}

func TestExecuteSyncDesiredStateInvalid(t *testing.T) {
	e := newReadyExecutor()
	if r := e.Execute(context.Background(), "sync_desired_state", map[string]interface{}{}); r.Success {
		t.Fatal("expected failure without desiredContainers")
	}
	if r := e.Execute(context.Background(), "sync_desired_state", map[string]interface{}{
		"desiredContainers": "not-array",
	}); r.Success {
		t.Fatal("expected failure for non-array desiredContainers")
	}
}

func TestHandleCommand(t *testing.T) {
	e := newReadyExecutor()
	success, output := e.HandleCommand(context.Background(), "run_step", map[string]interface{}{
		"shell": "echo adapter",
	})
	if !success {
		t.Fatalf("expected success, got failure: %s", output)
	}
	if !strings.Contains(output, "adapter") {
		t.Fatalf("expected output to contain 'adapter', got: %s", output)
	}
}

func TestDockerOpWithoutClient(t *testing.T) {
	e := newReadyExecutor()
	result := e.Execute(context.Background(), "docker_op", map[string]interface{}{
		"operation": "start",
		"args":      map[string]interface{}{"container": "abc"},
	})
	if result.Success {
		t.Fatal("expected failure when docker client is nil")
	}
}

func TestDockerOpShellRuntime(t *testing.T) {
	e := NewExecutor(nil)
	e.Configure(nil, RuntimeShell)
	result := e.Execute(context.Background(), "docker_op", map[string]interface{}{
		"operation": "start",
		"args":      map[string]interface{}{"container": "abc"},
	})
	if result.Success {
		t.Fatal("expected failure for shell-only runtime")
	}
	if !strings.Contains(strings.ToLower(result.Output), "shell") {
		t.Fatalf("expected shell runtime message, got: %s", result.Output)
	}
}

func TestDockerOpKubernetesRuntime(t *testing.T) {
	e := NewExecutor(nil)
	e.Configure(nil, RuntimeKubernetes)
	result := e.Execute(context.Background(), "docker_op", map[string]interface{}{
		"operation": "build",
		"args":      map[string]interface{}{"path": "."},
	})
	if result.Success {
		t.Fatal("expected failure for kubernetes runtime docker_op")
	}
	if !strings.Contains(strings.ToLower(result.Output), "kubernetes") {
		t.Fatalf("expected kubernetes message, got: %s", result.Output)
	}
}

func TestExecuteRunCursorPlan(t *testing.T) {
	t.Setenv("SM_CURSOR_BIN", "/bin/echo")
	e := newReadyExecutor()
	result := e.Execute(context.Background(), "run_cursor_plan", map[string]interface{}{
		"prompt":        "propose a fix",
		"workspacePath": t.TempDir(),
		"env": map[string]interface{}{
			"SM_INCIDENT_ID": "inc-1",
		},
		"permissionsProfile": "repo",
	})
	if !result.Success {
		t.Fatalf("expected success, got failure: %s", result.Output)
	}
	if !strings.Contains(result.Output, "--prompt") {
		t.Fatalf("expected output to contain CLI args, got: %s", result.Output)
	}
	if !strings.Contains(result.Output, "log_uri=file://") {
		t.Fatalf("expected output to contain log URI, got: %s", result.Output)
	}
}

func TestExecuteRunClaudePlanMissingPrompt(t *testing.T) {
	e := newReadyExecutor()
	result := e.Execute(context.Background(), "run_claude_plan", map[string]interface{}{})
	if result.Success {
		t.Fatal("expected failure for missing prompt")
	}
	if !strings.Contains(result.Output, "missing plan prompt") {
		t.Fatalf("unexpected output: %s", result.Output)
	}
}

func TestExecuteRunPlanIsolationMissingImage(t *testing.T) {
	t.Setenv("SM_EXECUTOR_ISOLATE_CONTAINERS", "1")
	t.Setenv("SM_EXECUTOR_RUNNER_IMAGE", "")
	t.Setenv("SM_EXECUTOR_DOCKER_BIN", "/bin/echo")
	t.Setenv("SM_CURSOR_BIN", "cursor")
	e := newReadyExecutor()
	result := e.Execute(context.Background(), "run_cursor_plan", map[string]interface{}{
		"prompt":        "test",
		"workspacePath": t.TempDir(),
	})
	if result.Success {
		t.Fatal("expected failure when runner image is missing")
	}
	if !strings.Contains(result.Output, "runner image is not configured") {
		t.Fatalf("unexpected output: %s", result.Output)
	}
}

func TestExecuteRunPlanWritesAuditArtifacts(t *testing.T) {
	t.Setenv("SM_CURSOR_BIN", "/bin/echo")
	workspace := t.TempDir()
	e := newReadyExecutor()
	result := e.Execute(context.Background(), "run_cursor_plan", map[string]interface{}{
		"prompt":        "audit me",
		"workspacePath": workspace,
	})
	if !result.Success {
		t.Fatalf("expected success, got failure: %s", result.Output)
	}
	logDir := workspace + "/.sm/logs"
	if _, err := os.Stat(logDir); err != nil {
		t.Fatalf("expected logs directory to exist: %v", err)
	}
}
