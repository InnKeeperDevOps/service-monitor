package main

import (
	"testing"

	"github.com/service-monitor/agent/internal/docker"
)

func TestServiceIDForContainer_PrefersName(t *testing.T) {
	got := serviceIDForContainer(docker.ContainerInfo{
		ID:    "1234567890abcdef",
		Names: []string{"/payments-api"},
	})
	if got != "payments-api" {
		t.Fatalf("serviceIDForContainer() = %q, want %q", got, "payments-api")
	}
}

func TestServiceIDForContainer_FallsBackToShortID(t *testing.T) {
	got := serviceIDForContainer(docker.ContainerInfo{
		ID:    "1234567890abcdef",
		Names: nil,
	})
	if got != "1234567890ab" {
		t.Fatalf("serviceIDForContainer() = %q, want %q", got, "1234567890ab")
	}
}

func TestServiceIDForContainer_UnknownWhenMissing(t *testing.T) {
	got := serviceIDForContainer(docker.ContainerInfo{})
	if got != "unknown-service" {
		t.Fatalf("serviceIDForContainer() = %q, want %q", got, "unknown-service")
	}
}

