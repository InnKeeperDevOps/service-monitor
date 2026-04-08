package executor

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestToolchainArgv(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	py := filepath.Join(dir, "a.py")
	if err := os.WriteFile(py, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	jar := filepath.Join(dir, "app.jar")
	if err := os.WriteFile(jar, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	goFile := filepath.Join(dir, "main.go")
	if err := os.WriteFile(goFile, []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "hello")
	if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}

	pyAbs, _ := filepath.Abs(py)
	jarAbs, _ := filepath.Abs(jar)
	goAbs, _ := filepath.Abs(goFile)
	binAbs, _ := filepath.Abs(bin)

	tests := []struct {
		lang    string
		path    string
		extra   []string
		want    []string
		wantErr string
	}{
		{"python3", py, []string{"-u"}, append([]string{"python3", pyAbs}, "-u"), ""},
		{"node", py, nil, []string{"node", pyAbs}, ""},
		{"php", py, nil, []string{"php", pyAbs}, ""},
		{"java", jar, []string{"a"}, append([]string{"java", "-jar", jarAbs}, "a"), ""},
		{"java", py, nil, nil, `java: path must be a ".jar" file`},
		{"go", goAbs, nil, []string{"go", "run", goAbs}, ""},
		{"go", binAbs, []string{"x"}, append([]string{binAbs}, "x"), ""},
		{"typescript", py, nil, append(append([]string{}, typescriptRunner()...), pyAbs), ""},
		{"kotlin", py, nil, append(append([]string{}, kotlinRunner()...), pyAbs), ""},
		{"swift", py, nil, []string{"swift", pyAbs}, ""},
		{"rust", binAbs, nil, []string{binAbs}, ""},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.lang+"_"+filepath.Base(tc.path), func(t *testing.T) {
			t.Parallel()
			got, err := ToolchainArgv(tc.lang, tc.path, tc.extra)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("want error containing %q, got err=%v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("argv:\nwant %#v\n got %#v", tc.want, got)
			}
		})
	}
}

func TestToolchainArgv_rust_rs_returns_error(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rs := filepath.Join(dir, "x.rs")
	if err := os.WriteFile(rs, []byte("fn main(){}"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := ToolchainArgv("rust", rs, nil)
	if err == nil || !strings.Contains(err.Error(), "rust") {
		t.Fatalf("expected error for .rs in ToolchainArgv, got %v", err)
	}
}

func TestExecuteRunToolchain_python3(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "t.py")
	if err := os.WriteFile(script, []byte("print(42)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := newReadyExecutor()
	r := e.Execute(context.Background(), "run_toolchain", map[string]interface{}{
		"language": "python3",
		"path":     script,
	})
	if !r.Success {
		t.Fatalf("expected success: %s", r.Output)
	}
	if !strings.Contains(strings.TrimSpace(r.Output), "42") {
		t.Fatalf("output: %q", r.Output)
	}
}
