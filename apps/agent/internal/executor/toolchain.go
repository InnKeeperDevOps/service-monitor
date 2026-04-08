package executor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// SupportedToolchainLanguages lists languages accepted by run_toolchain (matches packages/contracts toolchainLanguageSchema).
var SupportedToolchainLanguages = []string{
	"python3", "java", "node", "go", "php", "typescript", "rust", "swift", "kotlin",
}

// typescriptRunner returns argv prefix before the script path (e.g. npx, --yes, tsx).
func typescriptRunner() []string {
	if v := strings.TrimSpace(os.Getenv("SM_TYPESCRIPT_RUNNER")); v != "" {
		return strings.Fields(v)
	}
	return []string{"npx", "--yes", "tsx"}
}

// kotlinRunner returns argv prefix before the script path for .kts files.
func kotlinRunner() []string {
	if v := strings.TrimSpace(os.Getenv("SM_KOTLIN_RUNNER")); v != "" {
		return strings.Fields(v)
	}
	return []string{"kotlin"}
}

// ToolchainArgv builds an argv slice for exec.Command(name, args...). path must be non-empty.
// For java, non-.jar paths are rejected (use run_step for java -cp …).
func ToolchainArgv(language, path string, extra []string) ([]string, error) {
	language = strings.ToLower(strings.TrimSpace(language))
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("toolchain path: %w", err)
	}
	low := strings.ToLower(abs)
	switch language {
	case "python3":
		return append([]string{"python3", abs}, extra...), nil
	case "node":
		return append([]string{"node", abs}, extra...), nil
	case "php":
		return append([]string{"php", abs}, extra...), nil
	case "swift":
		return append([]string{"swift", abs}, extra...), nil
	case "java":
		if strings.HasSuffix(low, ".jar") {
			return append([]string{"java", "-jar", abs}, extra...), nil
		}
		return nil, fmt.Errorf(`java: path must be a ".jar" file on the agent host, or use run_step for "java -cp …"`)
	case "go":
		if strings.HasSuffix(low, ".go") {
			return append([]string{"go", "run", abs}, extra...), nil
		}
		return append([]string{abs}, extra...), nil
	case "typescript":
		prefix := typescriptRunner()
		out := make([]string, 0, len(prefix)+1+len(extra))
		out = append(out, prefix...)
		out = append(out, abs)
		out = append(out, extra...)
		return out, nil
	case "kotlin":
		prefix := kotlinRunner()
		out := make([]string, 0, len(prefix)+1+len(extra))
		out = append(out, prefix...)
		out = append(out, abs)
		out = append(out, extra...)
		return out, nil
	case "rust":
		if strings.HasSuffix(low, ".rs") {
			return nil, ErrToolchainRustSource
		}
		return append([]string{abs}, extra...), nil
	default:
		return nil, fmt.Errorf("unsupported toolchain language: %q", language)
	}
}

// ErrToolchainRustSource signals that executeRunToolchain should compile a .rs file then run the binary.
var ErrToolchainRustSource = errors.New("rust .rs source file")

func mergeEnvForToolchain(base []string, extra map[string]string) []string {
	if len(extra) == 0 {
		return base
	}
	out := append([]string(nil), base...)
	for k, v := range extra {
		out = append(out, fmt.Sprintf("%s=%s", k, v))
	}
	return out
}

func stringSliceFromPayload(v interface{}) []string {
	raw, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, x := range raw {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func stringMapFromPayload(v interface{}) map[string]string {
	raw, ok := v.(map[string]interface{})
	if !ok {
		return nil
	}
	out := make(map[string]string, len(raw))
	for k, val := range raw {
		if s, ok := val.(string); ok {
			out[k] = s
		}
	}
	return out
}

func (e *Executor) executeRunToolchain(ctx context.Context, payload map[string]interface{}) CommandResult {
	lang, _ := payload["language"].(string)
	path, _ := payload["path"].(string)
	if strings.TrimSpace(path) == "" {
		return CommandResult{Success: false, Output: "missing path"}
	}
	if strings.TrimSpace(lang) == "" {
		return CommandResult{Success: false, Output: "missing language"}
	}
	lang = strings.ToLower(strings.TrimSpace(lang))
	extra := stringSliceFromPayload(payload["args"])
	cwd, _ := payload["cwd"].(string)
	env := stringMapFromPayload(payload["env"])

	absPath, err := filepath.Abs(path)
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("toolchain path: %v", err)}
	}

	if lang == "rust" && strings.HasSuffix(strings.ToLower(absPath), ".rs") {
		return executeRustSource(ctx, absPath, extra, cwd, env)
	}

	argv, err := ToolchainArgv(lang, absPath, extra)
	if err != nil {
		return CommandResult{Success: false, Output: err.Error()}
	}
	if len(argv) == 0 {
		return CommandResult{Success: false, Output: "empty toolchain argv"}
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = mergeEnvForToolchain(os.Environ(), env)
	out, runErr := cmd.CombinedOutput()
	output := string(out)
	if runErr != nil {
		return CommandResult{Success: false, Output: strings.TrimSpace(output + "\n" + runErr.Error())}
	}
	return CommandResult{Success: true, Output: output}
}

func executeRustSource(ctx context.Context, sourcePath string, extra []string, cwd string, env map[string]string) CommandResult {
	dir := filepath.Join(filepath.Dir(sourcePath), ".sm", "rust-build")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("mkdir rust build: %v", err)}
	}
	binPath := filepath.Join(dir, fmt.Sprintf("sm-rust-%d", time.Now().UnixNano()))
	defer func() { _ = os.Remove(binPath) }()

	compile := exec.CommandContext(ctx, "rustc", sourcePath, "-o", binPath)
	if cwd != "" {
		compile.Dir = cwd
	}
	compile.Env = mergeEnvForToolchain(os.Environ(), env)
	out, err := compile.CombinedOutput()
	if err != nil {
		return CommandResult{Success: false, Output: strings.TrimSpace(string(out) + "\n" + err.Error())}
	}

	run := exec.CommandContext(ctx, binPath, extra...)
	if cwd != "" {
		run.Dir = cwd
	}
	run.Env = mergeEnvForToolchain(os.Environ(), env)
	out2, err2 := run.CombinedOutput()
	output := string(out2)
	if err2 != nil {
		return CommandResult{Success: false, Output: strings.TrimSpace(output + "\n" + err2.Error())}
	}
	return CommandResult{Success: true, Output: output}
}
