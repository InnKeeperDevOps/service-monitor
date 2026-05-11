package executor

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// executeRunFixPlan handles the `run_fix_plan` agent command. It is the
// agent-side counterpart to apps/api/src/autoFixDispatcher.ts: clone the
// service repo into a per-error workspace, run the configured AI CLI with
// the error + context as the prompt, then (if claude actually changed any
// files) commit and push to the service's main branch.
//
// On success the output ends with `commit=<sha>` so the API can extract the
// SHA for the onFixCreated event.
func (e *Executor) executeRunFixPlan(ctx context.Context, payload map[string]interface{}) CommandResult {
	// Always log entry + outcome so the operator can trace auto-fix
	// runs by tailing the agent's stdout. The platform's ack pipeline
	// surfaces the output but only on demand; an emerg-log here makes
	// failures visible without round-tripping to the panel.
	cmdID, _ := payload["commandId"].(string)
	log.Printf("[agent:fixplan] start commandId=%s", cmdID)
	res := executeRunFixPlanInner(e, ctx, payload)
	if res.Success {
		log.Printf("[agent:fixplan] OK   commandId=%s output=%s", cmdID, truncateForLog(res.Output, 160))
	} else {
		log.Printf("[agent:fixplan] FAIL commandId=%s output=%s", cmdID, truncateForLog(res.Output, 320))
	}
	return res
}

func truncateForLog(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ⏎ ")
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

func executeRunFixPlanInner(e *Executor, ctx context.Context, payload map[string]interface{}) CommandResult {
	errorMessage, _ := payload["errorMessage"].(string)
	if strings.TrimSpace(errorMessage) == "" {
		return CommandResult{Success: false, Output: "missing errorMessage"}
	}
	gitRepoURL, _ := payload["gitRepoUrl"].(string)
	if strings.TrimSpace(gitRepoURL) == "" {
		return CommandResult{Success: false, Output: "missing gitRepoUrl"}
	}
	branch, _ := payload["branch"].(string)
	if strings.TrimSpace(branch) == "" {
		branch = "main"
	}
	errorGroupID, _ := payload["errorGroupId"].(string)
	if strings.TrimSpace(errorGroupID) == "" {
		errorGroupID = "unknown"
	}

	contextLines := stringSliceFrom(payload["contextLines"])

	workspaceRoot, err := ensureWorkspace(stringValue(payload["workspacePath"]))
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("prepare workspace: %v", err)}
	}
	scratch := filepath.Join(workspaceRoot, "fixes", errorGroupID+"-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("create fix workspace: %v", err)}
	}
	// Best-effort cleanup at end. Keep on failure for postmortem.
	defer func() {
		if r := recover(); r != nil {
			// don't swallow real panics
			panic(r)
		}
	}()

	env, cleanupKey, err := buildSSHEnvFromPayload(payload)
	if err != nil {
		return CommandResult{Success: false, Output: err.Error()}
	}
	defer cleanupKey()

	cloneOut, err := runGit(ctx, scratch, env, "clone", "--branch", branch, "--single-branch", gitRepoURL, ".")
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("git clone failed: %v\n%s", err, cloneOut)}
	}

	if _, err := runGit(ctx, scratch, env, "config", "user.email", "kaiad-bot@kaiad.dev"); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("git config user.email: %v", err)}
	}
	if _, err := runGit(ctx, scratch, env, "config", "user.name", "Kaiad Auto-Fix"); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("git config user.name: %v", err)}
	}

	prompt := buildFixPrompt(errorMessage, contextLines)
	planBin := planBinary("claude")
	planTimeoutDur := planTimeout()
	runCtx, cancel := context.WithTimeout(ctx, planTimeoutDur)
	defer cancel()

	// Claude refuses to run as uid 0 (--dangerously-skip-permissions
	// hardcodes a root guard, and --permission-mode bypassPermissions
	// resolves to the same check). The agent itself must run as root
	// for /var/run/docker.sock access, so the workaround is to switch
	// JUST the claude subprocess to a non-root uid (the `claude` user
	// the runtime Dockerfile creates at uid 1000). The cloned repo
	// scratch dir is chowned to that uid first so claude can write
	// commits + push.
	claudeUID := uint32(1000)
	claudeGID := uint32(1000)
	if err := chownTreeUnsafe(scratch, int(claudeUID), int(claudeGID)); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("chown scratch to claude: %v", err)}
	}
	// Real claude CLI: `claude -p "<prompt>"` is non-interactive mode; cwd is
	// inherited from the process (we set cmd.Dir = scratch below).
	// `--permission-mode bypassPermissions` is the same kill-permission-prompts
	// behaviour as --dangerously-skip-permissions, but without the
	// hard-fail-on-root guard the latter has. Agents commonly run as root in
	// a container with no shell login, so the root check would block every
	// automated fix run.
	// We deliberately omit --add-dir: it's variadic and would swallow the
	// positional prompt argument that follows. The working directory is enough.
	claudeArgs := []string{
		"-p",
		"--permission-mode", "bypassPermissions",
		prompt,
	}
	cmd := exec.CommandContext(runCtx, planBin, claudeArgs...)
	cmd.Dir = scratch
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}
	// Run as the unprivileged `claude` uid. The setuid + setgid combo
	// here is local to this child only; the parent agent process
	// keeps its root credential.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: claudeUID, Gid: claudeGID},
	}
	claudeOut, claudeErr := cmd.CombinedOutput()
	output := string(claudeOut)
	if claudeErr != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("claude run failed: %v\n%s", claudeErr, output)}
	}
	if runCtx.Err() == context.DeadlineExceeded {
		return CommandResult{Success: false, Output: fmt.Sprintf("claude timed out after %s\n%s", planTimeoutDur, output)}
	}

	// Chown back to root so the subsequent git add/commit/push (which
	// run as root inside this process) own the repo files. Without this
	// `git` would warn "detected dubious ownership" and refuse to act
	// on a repo owned by a different uid.
	if err := chownTreeUnsafe(scratch, 0, 0); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("chown scratch back to root: %v", err)}
	}

	statusOut, err := runGit(ctx, scratch, env, "status", "--porcelain")
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("git status failed: %v\n%s", err, statusOut)}
	}
	if strings.TrimSpace(statusOut) == "" {
		return CommandResult{
			Success: false,
			Output:  "claude completed but produced no file changes; nothing to commit\n" + output,
		}
	}

	if _, err := runGit(ctx, scratch, env, "add", "-A"); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("git add failed: %v", err)}
	}
	commitMessage := fmt.Sprintf("fix(auto): %s", truncate(errorMessage, 72))
	if _, err := runGit(ctx, scratch, env, "commit", "-m", commitMessage); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("git commit failed: %v", err)}
	}
	if _, err := runGit(ctx, scratch, env, "push", "origin", branch); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("git push failed: %v", err)}
	}
	shaOut, err := runGit(ctx, scratch, env, "rev-parse", "HEAD")
	if err != nil {
		return CommandResult{Success: true, Output: "commit=unknown\n" + output}
	}
	sha := strings.TrimSpace(shaOut)
	return CommandResult{Success: true, Output: fmt.Sprintf("commit=%s\n%s", sha, output)}
}

// buildSSHEnvFromPayload sets GIT_SSH_COMMAND for the duration of the fix run.
// Mirrors the same logic in executePlanRunner so the two stay consistent.
func buildSSHEnvFromPayload(payload map[string]interface{}) (map[string]string, func(), error) {
	env := map[string]string{}
	noop := func() {}
	sshKeyType := stringValue(payload["sshKeyType"])
	sshKeyValue := stringValue(payload["sshKeyValue"])

	if sshKeyType == "uploaded" && sshKeyValue != "" {
		f, err := os.CreateTemp("", "kaiad_fix_ssh_key_*")
		if err != nil {
			return nil, noop, fmt.Errorf("failed to create temp ssh key file: %v", err)
		}
		keyPath := f.Name()
		if err := f.Chmod(0o600); err != nil {
			_ = f.Close()
			_ = os.Remove(keyPath)
			return nil, noop, fmt.Errorf("failed to chmod ssh key file: %v", err)
		}
		if _, err := f.WriteString(sshKeyValue); err != nil {
			_ = f.Close()
			_ = os.Remove(keyPath)
			return nil, noop, fmt.Errorf("failed to write ssh key file: %v", err)
		}
		_ = f.Close()
		// Make the key readable by the unprivileged `claude` uid (1000)
		// in case Claude shells out to git during the fix (e.g. to
		// check log/blame for context). Mode stays 0600 — only the
		// target uid changes.
		_ = os.Chown(keyPath, 1000, 1000)
		env["GIT_SSH_COMMAND"] = fmt.Sprintf("ssh -i %s -o StrictHostKeyChecking=no -o BatchMode=yes", keyPath)
		return env, func() { _ = os.Remove(keyPath) }, nil
	}
	if sshKeyType == "local_path" && sshKeyValue != "" {
		env["GIT_SSH_COMMAND"] = fmt.Sprintf("ssh -i %s -o StrictHostKeyChecking=no -o BatchMode=yes", sshKeyValue)
		return env, noop, nil
	}
	// No key — let git fall back to whatever the agent's user already has.
	return env, noop, nil
}

func runGit(ctx context.Context, dir string, env map[string]string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func buildFixPrompt(errorMessage string, contextLines []string) string {
	var b strings.Builder
	b.WriteString("You are an automated code-fix agent invoked by Kaiad. ")
	b.WriteString("A running service has emitted the error below. You are inside a fresh clone of that service's repository at the working directory.\n\n")
	b.WriteString("ERROR:\n")
	b.WriteString(errorMessage)
	b.WriteString("\n\nLOG CONTEXT (last lines before the error):\n")
	if len(contextLines) == 0 {
		b.WriteString("(none)\n")
	} else {
		for _, l := range contextLines {
			b.WriteString(l)
			b.WriteByte('\n')
		}
	}
	b.WriteString("\nINSTRUCTIONS:\n")
	b.WriteString("1. Identify the root cause from the error and surrounding code.\n")
	b.WriteString("2. Edit only the files necessary to fix the bug. Do not change unrelated code, do not refactor.\n")
	b.WriteString("3. Do NOT run git commands. Do NOT commit or push. The harness will commit and push your changes after you exit.\n")
	b.WriteString("4. If you cannot find a fix, exit without modifying any files.\n")
	return b.String()
}

func stringSliceFrom(v interface{}) []string {
	raw, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, e := range raw {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// chownTreeUnsafe recursively chowns `root` to (uid, gid). "Unsafe"
// because it follows directory traversal at the kernel's behest —
// fine for a freshly-cloned, attacker-untrusted scratch dir; do NOT
// reuse this against paths an external party could craft.
func chownTreeUnsafe(root string, uid, gid int) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		return os.Chown(path, uid, gid)
	})
}
