package executor

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tarGzBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var raw bytes.Buffer
	gw := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gw)
	for name, content := range files {
		hdr := &tar.Header{
			Name:     name,
			Mode:     0o644,
			Size:     int64(len(content)),
			Typeflag: tar.TypeReg,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	return raw.Bytes()
}

func TestExtractTarGz_basic(t *testing.T) {
	dir := t.TempDir()
	payload := tarGzBytes(t, map[string]string{"hello.txt": "world"})
	err := extractTarGz(context.Background(), bytes.NewReader(payload), dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "hello.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "world" {
		t.Fatalf("content: %q", b)
	}
}

func TestExtractTarGz_strip(t *testing.T) {
	dir := t.TempDir()
	payload := tarGzBytes(t, map[string]string{"a/b/c.txt": "ok"})
	err := extractTarGz(context.Background(), bytes.NewReader(payload), dir, 1)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "b", "c.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "ok" {
		t.Fatalf("content: %q", b)
	}
}

func TestExtractTarGz_rejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	var raw bytes.Buffer
	gw := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gw)
	hdr := &tar.Header{Name: "../evil", Mode: 0o644, Size: 1, Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	err := extractTarGz(context.Background(), bytes.NewReader(raw.Bytes()), dir, 0)
	if err == nil || !strings.Contains(err.Error(), "illegal path") {
		t.Fatalf("expected illegal path error, got %v", err)
	}
}

func TestValidateArtifactURL(t *testing.T) {
	if err := validateArtifactURL("https://example.com/x.tgz"); err != nil {
		t.Fatal(err)
	}
	if err := validateArtifactURL("http://127.0.0.1/x"); err == nil {
		t.Fatal("expected http to be rejected without env")
	}
	t.Setenv("SM_ARTIFACT_ALLOW_HTTP", "1")
	if err := validateArtifactURL("http://127.0.0.1/x"); err != nil {
		t.Fatal(err)
	}
}

func TestExecuteReceiveSourceArchive_fromFile(t *testing.T) {
	e := newReadyExecutor()
	dir := t.TempDir()
	arch := filepath.Join(dir, "app.tar.gz")
	payload := tarGzBytes(t, map[string]string{"index.php": "<?php echo 1;"})
	if err := os.WriteFile(arch, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "out")
	r := e.Execute(context.Background(), "receive_source_archive", map[string]interface{}{
		"archivePath": arch,
		"destDir":     dest,
	})
	if !r.Success {
		t.Fatalf("expected success: %s", r.Output)
	}
	b, err := os.ReadFile(filepath.Join(dest, "index.php"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "<?php") {
		t.Fatalf("file: %s", b)
	}
}

func TestExecuteReceiveSourceArchive_fromURL(t *testing.T) {
	e := newReadyExecutor()
	dir := t.TempDir()
	dest := filepath.Join(dir, "out")
	blob := tarGzBytes(t, map[string]string{"a.txt": "hi"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/gzip")
		_, _ = w.Write(blob)
	}))
	defer srv.Close()

	t.Setenv("SM_ARTIFACT_ALLOW_HTTP", "1")
	r := e.Execute(context.Background(), "receive_source_archive", map[string]interface{}{
		"url":     srv.URL,
		"destDir": dest,
	})
	if !r.Success {
		t.Fatalf("expected success: %s", r.Output)
	}
	b, err := os.ReadFile(filepath.Join(dest, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "hi" {
		t.Fatalf("got %q", b)
	}
}

func TestExecuteReceiveSourceArchive_invalidArgs(t *testing.T) {
	e := newReadyExecutor()
	r := e.Execute(context.Background(), "receive_source_archive", map[string]interface{}{})
	if r.Success {
		t.Fatal("expected failure")
	}
	if !strings.Contains(r.Output, "exactly one") {
		t.Fatalf("output: %s", r.Output)
	}
}

func TestStripTarMemberName(t *testing.T) {
	if stripTarMemberName("a/b/c", 1) != "b/c" {
		t.Fatalf("got %q", stripTarMemberName("a/b/c", 1))
	}
	if stripTarMemberName("a/b/c", 5) != "" {
		t.Fatal("expected empty")
	}
	if stripTarMemberName("../evil", 0) != "../evil" {
		t.Fatalf("got %q", stripTarMemberName("../evil", 0))
	}
}

func TestIntFromPayload(t *testing.T) {
	if intFromPayload(map[string]interface{}{"stripComponents": float64(2)}, "stripComponents") != 2 {
		t.Fatal()
	}
}
