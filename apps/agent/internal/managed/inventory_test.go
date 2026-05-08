package managed

import (
	"testing"

	"github.com/service-monitor/agent/internal/docker"
)

func TestInventoryMatch(t *testing.T) {
	inv := New()
	inv.ReplaceDesired([]DesiredContainer{
		{ServiceID: "api", Image: "myorg/api:v1", State: "running"},
		{ServiceID: "db", Image: "postgres:16", State: "running"},
	})

	cases := []struct {
		name      string
		container docker.ContainerInfo
		wantSID   string
	}{
		{
			name:      "image tag match",
			container: docker.ContainerInfo{ID: "1", Names: []string{"/x"}, Image: "myorg/api:v1"},
			wantSID:   "api",
		},
		{
			name:      "image base match across tag difference",
			container: docker.ContainerInfo{ID: "2", Names: []string{"/y"}, Image: "myorg/api:v2"},
			wantSID:   "api",
		},
		{
			name:      "image base match with registry port intact",
			container: docker.ContainerInfo{ID: "3", Names: []string{"/z"}, Image: "postgres:16"},
			wantSID:   "db",
		},
		{
			name:      "name contains serviceId",
			container: docker.ContainerInfo{ID: "4", Names: []string{"/my-stack-api-1"}, Image: "other:1"},
			wantSID:   "api",
		},
		{
			name:      "unmatched container",
			container: docker.ContainerInfo{ID: "5", Names: []string{"/random"}, Image: "nginx:latest"},
			wantSID:   "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := inv.Match(tc.container)
			if got != tc.wantSID {
				t.Errorf("match: got %q, want %q", got, tc.wantSID)
			}
		})
	}
}

func TestInventoryHasAny(t *testing.T) {
	inv := New()
	if inv.HasAny() {
		t.Fatalf("expected empty inventory to be HasAny=false")
	}
	inv.ReplaceDesired([]DesiredContainer{{ServiceID: "api", Image: "nginx"}})
	if !inv.HasAny() {
		t.Fatalf("expected inventory to be HasAny=true after ReplaceDesired")
	}
	inv.ReplaceDesired(nil)
	if inv.HasAny() {
		t.Fatalf("expected inventory to be HasAny=false after empty ReplaceDesired")
	}
}

func TestInventorySkipsEmptyServiceID(t *testing.T) {
	inv := New()
	inv.ReplaceDesired([]DesiredContainer{
		{ServiceID: "", Image: "nginx"},
		{ServiceID: "valid", Image: "app"},
	})
	if got := len(inv.Desired()); got != 1 {
		t.Fatalf("expected 1 valid entry after filter, got %d", got)
	}
}
