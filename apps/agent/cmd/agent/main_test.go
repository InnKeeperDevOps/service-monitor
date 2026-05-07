package main

import (
	"testing"

	"github.com/service-monitor/agent/internal/docker"
)

func TestServiceIDForContainer_PrefersName(t *testing.T) {
	t.Setenv("SM_SERVICE_ID", "")
	got := serviceIDForContainer(docker.ContainerInfo{
		ID:    "1234567890abcdef",
		Names: []string{"/payments-api"},
	})
	if got != "payments-api" {
		t.Fatalf("serviceIDForContainer() = %q, want %q", got, "payments-api")
	}
}

func TestServiceIDForContainer_PinnedByEnv(t *testing.T) {
	t.Setenv("SM_SERVICE_ID", "svc-api-1")
	// Even when a container name and id are both available, the env override
	// must win so that an enrollment-token-baked SM_SERVICE_ID pins logs to
	// the tenant-scoped service the operator chose in the admin UI.
	got := serviceIDForContainer(docker.ContainerInfo{
		ID:    "1234567890abcdef",
		Names: []string{"/payments-api"},
	})
	if got != "svc-api-1" {
		t.Fatalf("serviceIDForContainer() = %q, want %q", got, "svc-api-1")
	}
}

func TestServiceIDForContainer_PinnedTrimsWhitespace(t *testing.T) {
	t.Setenv("SM_SERVICE_ID", "  svc-trimmed  ")
	got := serviceIDForContainer(docker.ContainerInfo{ID: "abc"})
	if got != "svc-trimmed" {
		t.Fatalf("serviceIDForContainer() = %q, want %q", got, "svc-trimmed")
	}
}

func TestServiceIDForContainer_FallsBackToShortID(t *testing.T) {
	t.Setenv("SM_SERVICE_ID", "")
	got := serviceIDForContainer(docker.ContainerInfo{
		ID:    "1234567890abcdef",
		Names: nil,
	})
	if got != "1234567890ab" {
		t.Fatalf("serviceIDForContainer() = %q, want %q", got, "1234567890ab")
	}
}

func TestServiceIDForContainer_UnknownWhenMissing(t *testing.T) {
	t.Setenv("SM_SERVICE_ID", "")
	got := serviceIDForContainer(docker.ContainerInfo{})
	if got != "unknown-service" {
		t.Fatalf("serviceIDForContainer() = %q, want %q", got, "unknown-service")
	}
}

