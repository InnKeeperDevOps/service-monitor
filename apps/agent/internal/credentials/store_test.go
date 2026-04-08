package credentials_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/service-monitor/agent/internal/credentials"
)

func TestPersistenceDisabledDoesNotUseDisk(t *testing.T) {
	t.Setenv("SM_AGENT_PERSIST_CREDENTIALS", "0")
	dir := t.TempDir()
	p := filepath.Join(dir, "agent-credential.json")
	t.Setenv("SM_CREDENTIAL_PATH", p)

	if err := credentials.Save(credentials.Credential{AgentID: "a", Token: "t"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("expected no credential file when persistence disabled, stat err=%v", err)
	}
	got, err := credentials.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil credential, got %+v", got)
	}
	if credentials.Exists() {
		t.Fatal("Exists should be false when persistence disabled")
	}
}

func TestSaveAndLoad(t *testing.T) {
	t.Setenv("SM_AGENT_PERSIST_CREDENTIALS", "1")
	dir := t.TempDir()
	p := filepath.Join(dir, "creds", "agent-credential.json")
	t.Setenv("SM_CREDENTIAL_PATH", p)

	want := credentials.Credential{
		AgentID:     "agent-42",
		Token:       "tok-secret",
		EnrolledAt:  time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
		RealtimeURL: "ws://example.com/realtime",
	}
	if err := credentials.Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := credentials.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got == nil {
		t.Fatal("Load returned nil")
	}
	if got.AgentID != want.AgentID {
		t.Errorf("AgentID: want %q, got %q", want.AgentID, got.AgentID)
	}
	if got.Token != want.Token {
		t.Errorf("Token: want %q, got %q", want.Token, got.Token)
	}
	if !got.EnrolledAt.Equal(want.EnrolledAt) {
		t.Errorf("EnrolledAt: want %v, got %v", want.EnrolledAt, got.EnrolledAt)
	}
	if got.RealtimeURL != want.RealtimeURL {
		t.Errorf("RealtimeURL: want %q, got %q", want.RealtimeURL, got.RealtimeURL)
	}
}

func TestLoadMissingFileReturnsNil(t *testing.T) {
	t.Setenv("SM_AGENT_PERSIST_CREDENTIALS", "1")
	dir := t.TempDir()
	t.Setenv("SM_CREDENTIAL_PATH", filepath.Join(dir, "nonexistent.json"))

	got, err := credentials.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

func TestSaveFilePermissions(t *testing.T) {
	t.Setenv("SM_AGENT_PERSIST_CREDENTIALS", "1")
	dir := t.TempDir()
	subdir := filepath.Join(dir, "nested")
	p := filepath.Join(subdir, "agent-credential.json")
	t.Setenv("SM_CREDENTIAL_PATH", p)

	cred := credentials.Credential{AgentID: "a", Token: "t"}
	if err := credentials.Save(cred); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("Stat file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("file perm: want 0600, got %04o", perm)
	}

	dirInfo, err := os.Stat(subdir)
	if err != nil {
		t.Fatalf("Stat dir: %v", err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0700 {
		t.Errorf("dir perm: want 0700, got %04o", perm)
	}
}

func TestExistsReturnsFalseWhenMissing(t *testing.T) {
	t.Setenv("SM_AGENT_PERSIST_CREDENTIALS", "1")
	dir := t.TempDir()
	t.Setenv("SM_CREDENTIAL_PATH", filepath.Join(dir, "nope.json"))

	if credentials.Exists() {
		t.Fatal("Exists should be false for missing file")
	}
}

func TestExistsReturnsTrueAfterSave(t *testing.T) {
	t.Setenv("SM_AGENT_PERSIST_CREDENTIALS", "1")
	dir := t.TempDir()
	t.Setenv("SM_CREDENTIAL_PATH", filepath.Join(dir, "agent-credential.json"))

	cred := credentials.Credential{AgentID: "a", Token: "t"}
	if err := credentials.Save(cred); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !credentials.Exists() {
		t.Fatal("Exists should be true after Save")
	}
}
