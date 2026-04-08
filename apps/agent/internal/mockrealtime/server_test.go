package mockrealtime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestHelloPayload_marshalJSON_roundTrip(t *testing.T) {
	t.Parallel()
	h := HelloPayload{
		RuntimeBackend: "docker",
		ConfigReady:    true,
		WorkloadSource: "binary",
		GithubRepo:     "a/b",
		DefaultBranch:  "main",
	}
	b, err := h.marshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got["type"] != "hello" || got["service"] != "realtime" {
		t.Fatalf("unexpected top-level: %v", got)
	}
}

func TestHelloPayload_configNotReady_nullSource(t *testing.T) {
	t.Parallel()
	h := HelloPayload{ConfigReady: false}
	b, err := h.marshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	wl, _ := raw["workload"].(map[string]interface{})
	if wl == nil {
		t.Fatal("expected workload")
	}
	if wl["source"] != nil {
		t.Fatalf("expected null workload.source, got %v", wl["source"])
	}
}

func TestServer_helloThenAck(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(NewServer(Config{
		Path:  "/realtime",
		Hello: DefaultHello(),
	}))
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	d := websocket.Dialer{}
	conn, _, err := d.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var hello map[string]interface{}
	if err := json.Unmarshal(data, &hello); err != nil {
		t.Fatal(err)
	}
	if hello["type"] != "hello" {
		t.Fatalf("first frame: %s", data)
	}

	hb := []byte(`{"type":"heartbeat","agentId":"a1","ts":"2020-01-01T00:00:00Z","capacity":4}`)
	if err := conn.WriteMessage(websocket.TextMessage, hb); err != nil {
		t.Fatal(err)
	}
	_, ackData, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	ok, err := ParseAck(ackData)
	if err != nil || !ok {
		t.Fatalf("expected ack, got %q err=%v", ackData, err)
	}
}

func TestServer_requireToken(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(NewServer(Config{
		Path:         "/realtime",
		RequireToken: "secret",
		Hello:        DefaultHello(),
	}))
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	d := websocket.Dialer{}
	_, resp, err := d.Dial(u, nil)
	if err == nil {
		t.Fatal("expected dial failure")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %v err=%v", resp, err)
	}
}

func TestServer_injectAfterHeartbeat(t *testing.T) {
	t.Parallel()
	inject := MustJSON(map[string]interface{}{
		"type":      "run_step",
		"commandId": "cmd-test-1",
		"shell":     "echo ok",
		"env":       map[string]string{},
	})
	srv := httptest.NewServer(NewServer(Config{
		Path:                      "/realtime",
		Hello:                     DefaultHello(),
		InjectAfterFirstHeartbeat: inject,
	}))
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	d := websocket.Dialer{}
	conn, _, err := d.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if _, _, err := conn.ReadMessage(); err != nil { // hello
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"heartbeat","agentId":"a1","ts":"2020-01-01T00:00:00Z","capacity":4}`)); err != nil {
		t.Fatal(err)
	}
	// ack to heartbeat
	if _, data, err := conn.ReadMessage(); err != nil {
		t.Fatal(err)
	} else if ok, _ := ParseAck(data); !ok {
		t.Fatalf("expected ack after heartbeat: %s", data)
	}
	// injected command
	_, cmdData, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		Type      string `json:"type"`
		CommandID string `json:"commandId"`
	}
	if err := json.Unmarshal(cmdData, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "run_step" || env.CommandID != "cmd-test-1" {
		t.Fatalf("unexpected inject: %s", cmdData)
	}
}

func TestServer_injectReceiveSourceArchive(t *testing.T) {
	t.Parallel()
	inject := MustJSON(ReceiveSourceArchiveCommand("/var/stage/app.tar.gz", "/tmp/ws-out", "cmd-recv-1"))
	srv := httptest.NewServer(NewServer(Config{
		Path:                      "/realtime",
		Hello:                     DefaultHello(),
		InjectAfterFirstHeartbeat: inject,
	}))
	defer srv.Close()

	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/realtime"
	d := websocket.Dialer{}
	conn, _, err := d.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if _, _, err := conn.ReadMessage(); err != nil { // hello
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"heartbeat","agentId":"a1","ts":"2020-01-01T00:00:00Z","capacity":4}`)); err != nil {
		t.Fatal(err)
	}
	if _, data, err := conn.ReadMessage(); err != nil {
		t.Fatal(err)
	} else if ok, _ := ParseAck(data); !ok {
		t.Fatalf("expected ack after heartbeat: %s", data)
	}
	_, cmdData, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		Type        string `json:"type"`
		CommandID   string `json:"commandId"`
		ArchivePath string `json:"archivePath"`
		DestDir     string `json:"destDir"`
	}
	if err := json.Unmarshal(cmdData, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "receive_source_archive" || env.CommandID != "cmd-recv-1" {
		t.Fatalf("unexpected inject: %s", cmdData)
	}
	if env.ArchivePath != "/var/stage/app.tar.gz" || env.DestDir != "/tmp/ws-out" {
		t.Fatalf("paths: %+v", env)
	}
}

func TestServer_wrongPath404(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(NewServer(Config{Path: "/realtime", Hello: DefaultHello()}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/other")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("got %d", resp.StatusCode)
	}
}

func TestServer_methodNotAllowed(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(NewServer(Config{Path: "/realtime", Hello: DefaultHello()}))
	defer srv.Close()

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/realtime", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("got %d", resp.StatusCode)
	}
}

func TestParseAck(t *testing.T) {
	t.Parallel()
	ok, err := ParseAck([]byte(`{"type":"ack","accepted":true}`))
	if err != nil || !ok {
		t.Fatalf("got ok=%v err=%v", ok, err)
	}
	ok, err = ParseAck([]byte(`{"type":"nope"}`))
	if err != nil || ok {
		t.Fatalf("expected false")
	}
}
