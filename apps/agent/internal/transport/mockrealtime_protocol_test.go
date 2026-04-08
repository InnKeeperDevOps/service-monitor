// Integration-style tests: mock Kaiad /realtime (internal/mockrealtime) + transport Client + executor,
// with captured protocol debug lines to validate request/response behavior.
package transport_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"log"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/service-monitor/agent/internal/docker"
	"github.com/service-monitor/agent/internal/executor"
	"github.com/service-monitor/agent/internal/mockrealtime"
	"github.com/service-monitor/agent/internal/transport"
)

func TestMockRealtime_AgentStack_protocolDebugAndCommandAck(t *testing.T) {
	t.Setenv("SM_AGENT_DEBUG", "1")
	t.Setenv("SM_SKIP_KAIAD_CONFIG_WAIT", "1")
	t.Setenv("SM_ENABLE_LOG_STREAMING", "0")
	_ = os.Setenv("HOME", t.TempDir())

	var logBuf bytes.Buffer
	log.SetOutput(&logBuf)
	defer log.SetOutput(os.Stderr)

	inject := mockrealtime.MustJSON(map[string]interface{}{
		"type":      "run_step",
		"commandId": "cmd-mock-proto-1",
		"shell":     "echo mockok",
		"env":       map[string]string{},
	})

	var srvMu sync.Mutex
	var serverMsgTypes []string
	onAgent := func(typ string, raw []byte) {
		srvMu.Lock()
		serverMsgTypes = append(serverMsgTypes, typ)
		srvMu.Unlock()
	}

	ms := mockrealtime.NewServer(mockrealtime.Config{
		Path:                      "/realtime",
		Hello:                     mockrealtime.DefaultHello(),
		InjectAfterFirstHeartbeat: inject,
		OnAgentMessage:            onAgent,
		Logf:                      func(string, ...interface{}) {},
	})
	srv := httptest.NewServer(ms)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	dc := docker.NewClient("")
	exec := executor.NewExecutor(dc)

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	client := transport.NewClient(wsURL, "agent-proto-test",
		transport.WithHeartbeatInterval(80*time.Millisecond),
		transport.WithReconnectBackoff(5*time.Millisecond, 50*time.Millisecond),
		transport.WithCommandHandler(exec),
		transport.OnHello(func(h transport.AgentHello) {
			ready, wsrc := h.ResolveKaiadConfig(true)
			exec.Configure(dc, executor.RuntimeDocker, ready, wsrc)
		}),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	deadline := time.After(6 * time.Second)
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	hasCommandAck := func() bool {
		srvMu.Lock()
		defer srvMu.Unlock()
		for _, typ := range serverMsgTypes {
			if typ == "command_ack" {
				return true
			}
		}
		return false
	}
	for !hasCommandAck() {
		select {
		case <-deadline:
			t.Fatalf("timeout: server saw types=%v log=\n%s", serverMsgTypes, logBuf.String())
		case <-tick.C:
		}
	}
	cancel()

	select {
	case err := <-errCh:
		if err != nil && err != context.Canceled {
			t.Fatalf("RunContext: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("client did not stop")
	}

	dumped := logBuf.String()
	if !strings.Contains(dumped, "outbound command_ack") || !strings.Contains(dumped, "cmd-mock-proto-1") {
		t.Fatalf("expected transport debug to mention command_ack and command id; got:\n%s", dumped)
	}
	if !strings.Contains(dumped, "[agent:executor] HandleCommand type=run_step") {
		t.Fatalf("expected executor debug line; got:\n%s", dumped)
	}
	if !strings.Contains(dumped, "handler result") {
		t.Fatalf("expected handler result line; got:\n%s", dumped)
	}

	srvMu.Lock()
	types := append([]string(nil), serverMsgTypes...)
	srvMu.Unlock()
	if !containsInOrder(types, "heartbeat", "command_ack") {
		t.Fatalf("server should see heartbeat then command_ack in message stream; got %v", types)
	}
}

func testTarGzBytes(t *testing.T, files map[string]string) []byte {
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

func TestMockRealtime_AgentStack_receiveSourceArchive(t *testing.T) {
	t.Setenv("SM_AGENT_DEBUG", "1")
	t.Setenv("SM_SKIP_KAIAD_CONFIG_WAIT", "1")
	t.Setenv("SM_ENABLE_LOG_STREAMING", "0")
	_ = os.Setenv("HOME", t.TempDir())

	extractRoot := t.TempDir()
	archPath := filepath.Join(t.TempDir(), "bundle.tgz")
	if err := os.WriteFile(archPath, testTarGzBytes(t, map[string]string{"hello.php": "<?php"}), 0o644); err != nil {
		t.Fatal(err)
	}

	inject := mockrealtime.MustJSON(mockrealtime.ReceiveSourceArchiveCommand(archPath, extractRoot, "cmd-mock-recv-archive"))

	var logBuf bytes.Buffer
	log.SetOutput(&logBuf)
	defer log.SetOutput(os.Stderr)

	ms := mockrealtime.NewServer(mockrealtime.Config{
		Path:                      "/realtime",
		Hello:                     mockrealtime.DefaultHello(),
		InjectAfterFirstHeartbeat: inject,
		Logf:                      func(string, ...interface{}) {},
	})
	srv := httptest.NewServer(ms)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	dc := docker.NewClient("")
	exec := executor.NewExecutor(dc)

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	client := transport.NewClient(wsURL, "agent-recv-archive-test",
		transport.WithHeartbeatInterval(80*time.Millisecond),
		transport.WithReconnectBackoff(5*time.Millisecond, 50*time.Millisecond),
		transport.WithCommandHandler(exec),
		transport.OnHello(func(h transport.AgentHello) {
			ready, wsrc := h.ResolveKaiadConfig(true)
			exec.Configure(dc, executor.RuntimeDocker, ready, wsrc)
		}),
	)

	errCh := make(chan error, 1)
	go func() { errCh <- client.RunContext(ctx) }()

	deadline := time.After(6 * time.Second)
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	dumped := ""
	for {
		dumped = logBuf.String()
		// Executor success text is not duplicated to the logger; transport logs handler result.
		if strings.Contains(dumped, "handler result commandId=cmd-mock-recv-archive success=true") {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("timeout waiting for receive_source_archive; log=\n%s", dumped)
		case <-tick.C:
		}
	}
	cancel()

	select {
	case err := <-errCh:
		if err != nil && err != context.Canceled {
			t.Fatalf("RunContext: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("client did not stop")
	}

	if !strings.Contains(dumped, "[agent:executor] HandleCommand type=receive_source_archive") {
		t.Fatalf("expected executor line; got:\n%s", dumped)
	}
	body, err := os.ReadFile(filepath.Join(extractRoot, "hello.php"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "<?php" {
		t.Fatalf("extracted file: %q", body)
	}
}

func containsInOrder(types []string, a, b string) bool {
	ia, ib := -1, -1
	for i, typ := range types {
		if typ == a && ia < 0 {
			ia = i
		}
		if typ == b && ib < 0 {
			ib = i
		}
	}
	return ia >= 0 && ib >= 0 && ia < ib
}

func TestMockRealtime_SM_AGENT_DEBUG_enablesDefaultTransportLogging(t *testing.T) {
	t.Setenv("SM_AGENT_DEBUG", "1")
	t.Setenv("SM_SKIP_KAIAD_CONFIG_WAIT", "1")

	var logBuf bytes.Buffer
	log.SetOutput(&logBuf)
	defer log.SetOutput(os.Stderr)

	ms := mockrealtime.NewServer(mockrealtime.Config{
		Path:  "/realtime",
		Hello: mockrealtime.DefaultHello(),
		Logf:  func(string, ...interface{}) {},
	})
	srv := httptest.NewServer(ms)
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	c := transport.NewClient(wsURL, "dbg-env",
		transport.WithHeartbeatInterval(60*time.Millisecond),
		transport.WithReconnectBackoff(5*time.Millisecond, 40*time.Millisecond),
	)
	// No WithProtocolDebugLog — NewClient should attach default logger when SM_AGENT_DEBUG=1
	err := c.RunContext(ctx)
	if err != context.DeadlineExceeded {
		t.Fatalf("want deadline, got %v", err)
	}
	out := logBuf.String()
	if !strings.Contains(out, "[agent:transport]") || !strings.Contains(out, "websocket connected") {
		t.Fatalf("expected default debug log to std logger; got:\n%s", out)
	}
}

func TestMockRealtime_serverRecordsAgentFrames(t *testing.T) {
	t.Parallel()
	var frames []struct {
		Typ string
		Raw string
	}
	var mu sync.Mutex
	ms := mockrealtime.NewServer(mockrealtime.Config{
		Path:  "/realtime",
		Hello: mockrealtime.DefaultHello(),
		OnAgentMessage: func(typ string, raw []byte) {
			mu.Lock()
			frames = append(frames, struct {
				Typ string
				Raw string
			}{Typ: typ, Raw: string(raw)})
			mu.Unlock()
		},
		Logf: func(string, ...interface{}) {},
	})
	srv := httptest.NewServer(ms)
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	cl := transport.NewClient(u, "rec-test",
		transport.WithHeartbeatInterval(50*time.Millisecond),
		transport.WithReconnectBackoff(5*time.Millisecond, 30*time.Millisecond),
	)
	_ = cl.RunContext(ctx)

	mu.Lock()
	defer mu.Unlock()
	if len(frames) < 1 {
		t.Fatalf("expected at least one agent frame, got %d", len(frames))
	}
	var sawHeartbeat bool
	for _, f := range frames {
		if f.Typ == "heartbeat" {
			sawHeartbeat = true
			var hb map[string]interface{}
			if err := json.Unmarshal([]byte(f.Raw), &hb); err != nil {
				t.Fatalf("heartbeat JSON: %v", err)
			}
			if hb["agentId"] != "rec-test" {
				t.Fatalf("agentId: %v", hb["agentId"])
			}
		}
	}
	if !sawHeartbeat {
		t.Fatalf("expected heartbeat in frames: %+v", frames)
	}
}
