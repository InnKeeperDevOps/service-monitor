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
	_, err := os.Stat(CredentialPath())
	return err == nil
}
