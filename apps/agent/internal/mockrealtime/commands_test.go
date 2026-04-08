package mockrealtime

import (
	"encoding/json"
	"testing"
)

func TestReceiveSourceArchiveCommand_fields(t *testing.T) {
	t.Parallel()
	m := ReceiveSourceArchiveCommand("/data/app.tar.gz", "/out/ws", "c-99")
	b := MustJSON(m)
	var got map[string]interface{}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got["type"] != "receive_source_archive" || got["commandId"] != "c-99" {
		t.Fatalf("got %v", got)
	}
	if got["archivePath"] != "/data/app.tar.gz" || got["destDir"] != "/out/ws" {
		t.Fatalf("paths %v", got)
	}
}

func TestReceiveSourceArchiveCommand_defaultCommandID(t *testing.T) {
	t.Parallel()
	m := ReceiveSourceArchiveCommand("/a.tgz", "", "")
	if m["commandId"] != "mock-receive-archive-1" {
		t.Fatalf("commandId: %v", m["commandId"])
	}
	if _, ok := m["destDir"]; ok {
		t.Fatal("expected no destDir")
	}
}
