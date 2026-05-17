package lb

import (
	"archive/tar"
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/service-monitor/agent/internal/docker"
)

func TestEnvOr(t *testing.T) {
	os.Setenv("KAIAD_LB_TEST_VAR", "  set ")
	if got := envOr("KAIAD_LB_TEST_VAR", "def"); got != "set" {
		t.Fatalf("envOr set = %q", got)
	}
	os.Unsetenv("KAIAD_LB_TEST_VAR")
	if got := envOr("KAIAD_LB_TEST_VAR", "def"); got != "def" {
		t.Fatalf("envOr default = %q", got)
	}
}

func TestSnippetNameAndUniqueHosts(t *testing.T) {
	n := snippetName("svc-1", "prod")
	if n == "" || !strings.HasSuffix(n, ".conf") {
		t.Fatalf("snippetName = %q", n)
	}
	if snippetName("svc-1", "prod") != n {
		t.Fatal("snippetName not deterministic")
	}
	hosts := uniqueHosts([]Domain{
		{Host: "a.example.com", Port: 80, Protocol: "http"},
		{Host: "a.example.com", Port: 80, Protocol: "http"},
		{Host: "b.example.com", Port: 80, Protocol: "https"},
	})
	if len(hosts) != 2 {
		t.Fatalf("uniqueHosts = %v, want 2 unique", hosts)
	}
}

func TestRenderServiceConf(t *testing.T) {
	conf := renderServiceConf(
		"svc-1", "svc-1", "prod",
		[]string{"svc-1-c1:8080", "svc-1-c2:8080"},
		8080,
		[]Domain{{Host: "app.example.com", Port: 8080, Protocol: "https"}},
	)
	if conf == "" {
		t.Fatal("renderServiceConf returned empty")
	}
	for _, want := range []string{"app.example.com", "proxy_set_header", "server"} {
		if !strings.Contains(conf, want) {
			t.Fatalf("renderServiceConf missing %q in:\n%s", want, conf)
		}
	}
}

func TestBuildSingleFileTar(t *testing.T) {
	body := []byte("server { listen 80; }")
	out, err := buildSingleFileTar("svc.conf", body)
	if err != nil {
		t.Fatalf("buildSingleFileTar: %v", err)
	}
	tr := tar.NewReader(bytes.NewReader(out))
	h, err := tr.Next()
	if err != nil || h.Name != "svc.conf" {
		t.Fatalf("tar header = %+v err=%v", h, err)
	}
	got := make([]byte, len(body))
	_, _ = tr.Read(got)
	if string(got) != string(body) {
		t.Fatalf("tar body = %q", string(got))
	}
}

func TestDefaultManagerSmoke(t *testing.T) {
	m := DefaultManager(docker.NewClient("/nonexistent.sock"))
	if m == nil {
		t.Fatal("DefaultManager nil")
	}
	if m.NetworkName() == "" {
		t.Fatal("NetworkName empty")
	}
}
