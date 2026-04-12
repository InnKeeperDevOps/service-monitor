package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/agentdebug"
	"github.com/service-monitor/agent/internal/docker"
)

type CommandResult struct {
	Success bool
	Output  string
}

// RuntimeBackend is how Kaiad expects this agent to run workloads (tenant setting agentRuntimeBackend).
type RuntimeBackend string

const (
	RuntimeDocker       RuntimeBackend = "docker"
	RuntimeKubernetes   RuntimeBackend = "kubernetes"
	RuntimeShell        RuntimeBackend = "shell"
)

type Executor struct {
	mu               sync.RWMutex
	docker           *docker.Client
	backend          RuntimeBackend
	kaiadConfigReady bool
	workloadSource   string
}

const defaultPlanTimeout = 5 * time.Minute

func NewExecutor(dc *docker.Client) *Executor {
	return &Executor{docker: dc, backend: RuntimeDocker, kaiadConfigReady: false}
}

// Configure updates Docker handle, runtime mode, and Kaiad tenant policy after the realtime hello.
func (e *Executor) Configure(dc *docker.Client, backend RuntimeBackend, kaiadConfigReady bool, workloadSource string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.docker = dc
	if backend == "" {
		backend = RuntimeDocker
	}
	e.backend = backend
	e.kaiadConfigReady = kaiadConfigReady
	if workloadSource == "" && kaiadConfigReady {
		workloadSource = "git_repo"
	}
	e.workloadSource = workloadSource
}

func (e *Executor) kaiadAllowsWorkloads() bool {
	if os.Getenv("SM_SKIP_KAIAD_CONFIG_WAIT") == "1" {
		return true
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.kaiadConfigReady
}

// WorkloadSource returns the last workload mode from Kaiad hello ("git_repo" or "binary"), or empty if not ready.
func (e *Executor) WorkloadSource() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.workloadSource
}

func (e *Executor) runtime() (RuntimeBackend, *docker.Client) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	b := e.backend
	if b == "" {
		b = RuntimeDocker
	}
	return b, e.docker
}

// RunShell preserves the original stub API for backward compatibility.
func RunShell(command string) (string, error) {
	out, err := exec.Command("sh", "-c", command).CombinedOutput()
	return string(out), err
}

func (e *Executor) Execute(ctx context.Context, cmdType string, payload map[string]interface{}) CommandResult {
	if cmdType != "cancel_run" && !e.kaiadAllowsWorkloads() {
		return CommandResult{
			Success: false,
			Output:  `kaiad: agent configuration not ready; set Workload source in Kaiad Tenant Configuration (Settings), then reconnect the agent`,
		}
	}
	backend, dc := e.runtime()
	switch cmdType {
	case "run_step":
		return e.executeRunStep(ctx, payload)
	case "run_cursor_plan":
		return e.executePlanRunner(ctx, "cursor", backend, payload)
	case "run_claude_plan":
		return e.executePlanRunner(ctx, "claude", backend, payload)
	case "docker_op":
		return e.executeDockerOp(ctx, backend, dc, payload)
	case "cancel_run":
		return CommandResult{Success: true, Output: "cancelled"}
	case "sync_desired_state":
		return e.executeSyncDesiredState(payload)
	case "run_toolchain":
		return e.executeRunToolchain(ctx, payload)
	case "receive_source_archive":
		return e.executeReceiveSourceArchive(ctx, payload)
	default:
		return CommandResult{Success: false, Output: fmt.Sprintf("unknown command type: %s", cmdType)}
	}
}

// HandleCommand satisfies transport.CommandHandler.
func (e *Executor) HandleCommand(ctx context.Context, cmdType string, payload map[string]interface{}) (bool, string) {
	if agentdebug.Enabled() {
		log.Printf("[agent:executor] HandleCommand type=%s", cmdType)
	}
	r := e.Execute(ctx, cmdType, payload)
	return r.Success, r.Output
}

func (e *Executor) executeRunStep(ctx context.Context, payload map[string]interface{}) CommandResult {
	shell, _ := payload["shell"].(string)
	if shell == "" {
		return CommandResult{Success: false, Output: "missing shell command"}
	}
	cmd := exec.CommandContext(ctx, "sh", "-c", shell)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return CommandResult{Success: false, Output: string(out) + "\n" + err.Error()}
	}
	return CommandResult{Success: true, Output: string(out)}
}

func (e *Executor) executeSyncDesiredState(payload map[string]interface{}) CommandResult {
	raw, ok := payload["desiredContainers"]
	if !ok {
		return CommandResult{Success: false, Output: "missing desiredContainers"}
	}
	list, ok := raw.([]interface{})
	if !ok {
		return CommandResult{Success: false, Output: "desiredContainers must be an array"}
	}
	return CommandResult{Success: true, Output: fmt.Sprintf("sync_desired_state: %d entries", len(list))}
}

func (e *Executor) executeDockerOp(ctx context.Context, backend RuntimeBackend, dc *docker.Client, payload map[string]interface{}) CommandResult {
	switch backend {
	case RuntimeShell:
		return CommandResult{
			Success: false,
			Output:  `docker_op is disabled: tenant agent runtime is "shell" (change agent runtime in Kaiad tenant settings)`,
		}
	case RuntimeKubernetes:
		return CommandResult{
			Success: false,
			Output:  `docker_op is not mapped for "kubernetes" runtime yet; use run_step with kubectl`,
		}
	default:
		if dc == nil {
			return CommandResult{Success: false, Output: "docker client not configured"}
		}
	}
	operation, _ := payload["operation"].(string)
	args, _ := payload["args"].(map[string]interface{})
	if args == nil {
		args = make(map[string]interface{})
	}

	switch operation {
	case "start":
		id, _ := args["container"].(string)
		if id == "" {
			return CommandResult{Success: false, Output: "missing container id"}
		}
		if err := dc.StartContainer(ctx, id); err != nil {
			return CommandResult{Success: false, Output: err.Error()}
		}
		return CommandResult{Success: true, Output: "container started"}
	case "stop":
		id, _ := args["container"].(string)
		if id == "" {
			return CommandResult{Success: false, Output: "missing container id"}
		}
		if err := dc.StopContainer(ctx, id); err != nil {
			return CommandResult{Success: false, Output: err.Error()}
		}
		return CommandResult{Success: true, Output: "container stopped"}
	case "build", "run", "compose_up", "compose_down":
		return e.executeDockerCLI(ctx, operation, args)
	default:
		return CommandResult{Success: false, Output: fmt.Sprintf("unknown docker operation: %s", operation)}
	}
}

func (e *Executor) executeDockerCLI(ctx context.Context, operation string, args map[string]interface{}) CommandResult {
	var cmdStr string
	switch operation {
	case "build":
		path, _ := args["path"].(string)
		if path == "" {
			path = "."
		}
		tag, _ := args["tag"].(string)
		if tag != "" {
			cmdStr = fmt.Sprintf("docker build -t %s %s", tag, path)
		} else {
			cmdStr = fmt.Sprintf("docker build %s", path)
		}
	case "run":
		image, _ := args["image"].(string)
		cmdStr = fmt.Sprintf("docker run %s", image)
	case "compose_up":
		file, _ := args["file"].(string)
		if file != "" {
			cmdStr = fmt.Sprintf("docker-compose -f %s up -d", file)
		} else {
			cmdStr = "docker-compose up -d"
		}
	case "compose_down":
		file, _ := args["file"].(string)
		if file != "" {
			cmdStr = fmt.Sprintf("docker-compose -f %s down", file)
		} else {
			cmdStr = "docker-compose down"
		}
	}

	parts := strings.Fields(cmdStr)
	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return CommandResult{Success: false, Output: string(out) + "\n" + err.Error()}
	}
	return CommandResult{Success: true, Output: string(out)}
}

func planTimeout() time.Duration {
	if raw := os.Getenv("SM_EXECUTOR_TIMEOUT_MS"); raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return defaultPlanTimeout
}

func planArgs(executorID, prompt, workspace string) []string {
	if executorID == "cursor" {
		return []string{"--prompt", prompt, "--workspace", workspace}
	}
	return []string{"--prompt", prompt, "--cwd", workspace}
}

func planBinary(executorID string) string {
	if executorID == "cursor" {
		if v := os.Getenv("SM_CURSOR_BIN"); v != "" {
			return v
		}
		return "cursor"
	}
	if v := os.Getenv("SM_CLAUDE_BIN"); v != "" {
		return v
	}
	return "claude"
}

func containerIsolationEnabled(executorID string) bool {
	if os.Getenv("SM_EXECUTOR_ISOLATE_CONTAINERS") == "1" {
		return true
	}
	return os.Getenv("SM_EXECUTOR_ISOLATE_CONTAINERS_"+strings.ToUpper(executorID)) == "1"
}

func runnerImage(executorID string) string {
	if v := os.Getenv("SM_EXECUTOR_RUNNER_IMAGE_" + strings.ToUpper(executorID)); v != "" {
		return v
	}
	return os.Getenv("SM_EXECUTOR_RUNNER_IMAGE")
}

func dockerBinary() string {
	if v := os.Getenv("SM_EXECUTOR_DOCKER_BIN"); v != "" {
		return v
	}
	return "docker"
}

func payloadStringMap(v interface{}) map[string]string {
	out := map[string]string{}
	raw, ok := v.(map[string]interface{})
	if !ok {
		return out
	}
	for k, rv := range raw {
		if s, ok := rv.(string); ok {
			out[k] = s
		}
	}
	return out
}

func ensureWorkspace(path string) (string, error) {
	if path == "" {
		path = "/tmp/service-monitor-agent/workspace"
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", err
	}
	return abs, nil
}

func writeExecutionArtifacts(workspacePath, executorID string, content string, metadata map[string]interface{}) (string, error) {
	logDir := filepath.Join(workspacePath, ".sm", "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return "", err
	}
	ts := time.Now().UTC().Format("20060102T150405.000000000Z")
	logPath := filepath.Join(logDir, fmt.Sprintf("%s-%s.log", executorID, ts))
	if err := os.WriteFile(logPath, []byte(content), 0o644); err != nil {
		return "", err
	}
	if metadata != nil {
		b, _ := json.Marshal(metadata)
		_ = os.WriteFile(filepath.Join(logDir, fmt.Sprintf("%s-%s.audit.json", executorID, ts)), b, 0o644)
	}
	return logPath, nil
}

func (e *Executor) executePlanRunner(ctx context.Context, executorID string, backend RuntimeBackend, payload map[string]interface{}) CommandResult {
	prompt, _ := payload["prompt"].(string)
	if strings.TrimSpace(prompt) == "" {
		return CommandResult{Success: false, Output: "missing plan prompt"}
	}
	workspacePath, err := ensureWorkspace(stringValue(payload["workspacePath"]))
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("prepare workspace: %v", err)}
	}
	permissionsProfile := stringValue(payload["permissionsProfile"])
	if permissionsProfile == "" {
		permissionsProfile = "restricted"
	}
	extraEnv := payloadStringMap(payload["env"])
	extraEnv["SM_PERMISSIONS_PROFILE"] = permissionsProfile

	sshKeyType := stringValue(payload["sshKeyType"])
	sshKeyValue := stringValue(payload["sshKeyValue"])

	if sshKeyType == "uploaded" && sshKeyValue != "" {
		f, err := os.CreateTemp("", "kaiad_ssh_key_*")
		if err != nil {
			return CommandResult{Success: false, Output: fmt.Sprintf("failed to create temp ssh key file: %v", err)}
		}
		keyPath := f.Name()
		defer os.Remove(keyPath)
		if err := f.Chmod(0600); err != nil {
			f.Close()
			return CommandResult{Success: false, Output: fmt.Sprintf("failed to chmod ssh key file: %v", err)}
		}
		if _, err := f.WriteString(sshKeyValue); err != nil {
			f.Close()
			return CommandResult{Success: false, Output: fmt.Sprintf("failed to write ssh key file: %v", err)}
		}
		f.Close()
		extraEnv["GIT_SSH_COMMAND"] = fmt.Sprintf("ssh -i %s -o StrictHostKeyChecking=no", keyPath)
		
		// If using container isolation, we must mount the key into the container
		if containerIsolationEnabled(executorID) && backend == RuntimeDocker {
			payload["_internalSshKeyMount"] = keyPath
		}
	} else if sshKeyType == "local_path" && sshKeyValue != "" {
		extraEnv["GIT_SSH_COMMAND"] = fmt.Sprintf("ssh -i %s -o StrictHostKeyChecking=no", sshKeyValue)
		if containerIsolationEnabled(executorID) && backend == RuntimeDocker {
			payload["_internalSshKeyMount"] = sshKeyValue
		}
	}

	var cmdBin string
	var cmdArgs []string
	isolation := "host"
	image := ""
	planBin := planBinary(executorID)
	if containerIsolationEnabled(executorID) {
		if backend != RuntimeDocker {
			return CommandResult{
				Success: false,
				Output:  `container isolation requires agent runtime "docker" (set tenant agent runtime in Kaiad)`,
			}
		}
		image = runnerImage(executorID)
		if image == "" {
			return CommandResult{Success: false, Output: "container isolation enabled but runner image is not configured"}
		}
		isolation = "container"
		cmdBin = dockerBinary()
		envArgs := make([]string, 0, len(extraEnv)*2)
		for k, v := range extraEnv {
			envArgs = append(envArgs, "-e", fmt.Sprintf("%s=%s", k, v))
		}
		cmdArgs = append([]string{
			"run", "--rm", "--network", "none",
			"-v", workspacePath + ":/workspace",
			"-w", "/workspace",
		}, envArgs...)
		
		if keyMount, ok := payload["_internalSshKeyMount"].(string); ok && keyMount != "" {
			cmdArgs = append(cmdArgs, "-v", fmt.Sprintf("%s:%s:ro", keyMount, keyMount))
		}
		
		cmdArgs = append(cmdArgs, image, planBin)
		cmdArgs = append(cmdArgs, planArgs(executorID, prompt, "/workspace")...)
	} else {
		cmdBin = planBin
		cmdArgs = planArgs(executorID, prompt, workspacePath)
	}

	runCtx, cancel := context.WithTimeout(ctx, planTimeout())
	defer cancel()
	cmd := exec.CommandContext(runCtx, cmdBin, cmdArgs...)
	cmd.Dir = workspacePath
	cmd.Env = os.Environ()
	for k, v := range extraEnv {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}
	out, err := cmd.CombinedOutput()
	output := string(out)
	success := err == nil
	if err != nil {
		output = strings.TrimSpace(output + "\n" + err.Error())
	}
	if runCtx.Err() == context.DeadlineExceeded {
		success = false
		output = strings.TrimSpace(output + "\nexecutor timeout exceeded")
	}

	logPath, logErr := writeExecutionArtifacts(workspacePath, executorID, output, map[string]interface{}{
		"executor":           executorID,
		"command":            append([]string{cmdBin}, cmdArgs...),
		"isolation":          isolation,
		"runnerImage":        image,
		"permissionsProfile": permissionsProfile,
		"success":            success,
		"ts":                 time.Now().UTC().Format(time.RFC3339Nano),
	})
	if logErr == nil {
		output = strings.TrimSpace(output + "\nlog_uri=file://" + logPath)
	}

	return CommandResult{Success: success, Output: output}
}

func stringValue(v interface{}) string {
	s, _ := v.(string)
	return s
}
