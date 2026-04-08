package credentials

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

type Credential struct {
	AgentID     string    `json:"agentId"`
	Token       string    `json:"token"`
	EnrolledAt  time.Time `json:"enrolledAt"`
	RealtimeURL string    `json:"realtimeUrl"`
}

// PersistenceEnabled is true when SM_AGENT_PERSIST_CREDENTIALS=1.
// By default the agent is stateless: it does not read or write enrollment material on disk;
// supply SM_ENROLLMENT_TOKEN, SM_AGENT_ID, and SM_REALTIME_URL via the environment (e.g. Kubernetes secrets).
func PersistenceEnabled() bool {
	return os.Getenv("SM_AGENT_PERSIST_CREDENTIALS") == "1"
}

func CredentialPath() string {
	if p := os.Getenv("SM_CREDENTIAL_PATH"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".service-monitor", "agent-credential.json")
}

func Save(cred Credential) error {
	if !PersistenceEnabled() {
		return nil
	}
	p := CredentialPath()
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cred, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0600)
}

func Load() (*Credential, error) {
	if !PersistenceEnabled() {
		return nil, nil
	}
	data, err := os.ReadFile(CredentialPath())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var cred Credential
	if err := json.Unmarshal(data, &cred); err != nil {
		return nil, err
	}
	return &cred, nil
}

func Exists() bool {
	if !PersistenceEnabled() {
		return false
	}
	_, err := os.Stat(CredentialPath())
	return err == nil
}
