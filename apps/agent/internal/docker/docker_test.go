package docker

import "testing"

func TestParseStatus(t *testing.T) {
	s := ParseStatus("svc-1", "running")
	if s.ServiceID != "svc-1" || s.State != "running" {
		t.Fatalf("unexpected status: %+v", s)
	}
}

func TestNewClient(t *testing.T) {
	c := NewClient("")
	if c.SocketPath() != "/var/run/docker.sock" {
		t.Fatalf("expected default socket path, got %s", c.SocketPath())
	}
	if c.httpClient == nil {
		t.Fatal("expected non-nil http client")
	}
}

func TestNewClientCustomSocket(t *testing.T) {
	c := NewClient("/tmp/custom.sock")
	if c.SocketPath() != "/tmp/custom.sock" {
		t.Fatalf("expected /tmp/custom.sock, got %s", c.SocketPath())
	}
}
