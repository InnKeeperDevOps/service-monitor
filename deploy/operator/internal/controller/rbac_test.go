package controller

import (
	"strings"
	"testing"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	kaiadv1alpha1 "github.com/innkeeperdevops/kaiad/operator/api/v1alpha1"
)

func sampleAgent(rules []kaiadv1alpha1.ManagesRule) *kaiadv1alpha1.KaiadAgent {
	return &kaiadv1alpha1.KaiadAgent{
		ObjectMeta: metav1.ObjectMeta{Name: "edge", Namespace: "kaiad-system"},
		Spec: kaiadv1alpha1.KaiadAgentSpec{
			ControlPlane: kaiadv1alpha1.ControlPlaneSpec{RealtimeURL: "wss://x"},
			Image:        "img:1",
			Manages:      rules,
		},
	}
}

func TestValidateManages_AllowList(t *testing.T) {
	cases := []struct {
		name      string
		rules     []kaiadv1alpha1.ManagesRule
		wantErrIn string // substring expected; empty for success
	}{
		{
			name: "allowed: apps/deployments + pods/log",
			rules: []kaiadv1alpha1.ManagesRule{
				{APIGroups: []string{"apps"}, Resources: []string{"deployments"}, Verbs: []string{"get", "patch"}},
				{APIGroups: []string{""}, Resources: []string{"pods/log"}, Verbs: []string{"get"}},
			},
			wantErrIn: "",
		},
		{
			name: "allowed: full deploy surface (deployments+services+ingresses create/delete)",
			rules: []kaiadv1alpha1.ManagesRule{
				{APIGroups: []string{"apps"}, Resources: []string{"deployments", "statefulsets"}, Verbs: []string{"get", "list", "watch", "create", "update", "patch", "delete"}},
				{APIGroups: []string{""}, Resources: []string{"services"}, Verbs: []string{"get", "list", "watch", "create", "update", "patch", "delete"}},
				{APIGroups: []string{""}, Resources: []string{"namespaces"}, Verbs: []string{"get"}},
				{APIGroups: []string{"networking.k8s.io"}, Resources: []string{"ingresses"}, Verbs: []string{"get", "list", "watch", "create", "update", "patch", "delete"}},
			},
			wantErrIn: "",
		},
		{
			name: "blocked: pods create (read-only resource)",
			rules: []kaiadv1alpha1.ManagesRule{
				{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"create"}},
			},
			wantErrIn: `verb "create"`,
		},
		{
			name: "blocked: secrets",
			rules: []kaiadv1alpha1.ManagesRule{
				{APIGroups: []string{""}, Resources: []string{"secrets"}, Verbs: []string{"get"}},
			},
			wantErrIn: `"secrets"`,
		},
		{
			name: "blocked: clusterroles",
			rules: []kaiadv1alpha1.ManagesRule{
				{APIGroups: []string{"rbac.authorization.k8s.io"}, Resources: []string{"clusterroles"}, Verbs: []string{"get"}},
			},
			wantErrIn: `apiGroup "rbac.authorization.k8s.io"`,
		},
		{
			name: "blocked: wildcard verb",
			rules: []kaiadv1alpha1.ManagesRule{
				{APIGroups: []string{"apps"}, Resources: []string{"deployments"}, Verbs: []string{"*"}},
			},
			wantErrIn: `verb "*"`,
		},
		{
			name: "blocked: wildcard resource",
			rules: []kaiadv1alpha1.ManagesRule{
				{APIGroups: []string{"apps"}, Resources: []string{"*"}, Verbs: []string{"get"}},
			},
			wantErrIn: `resource "*"`,
		},
		{
			name:  "empty rules ok",
			rules: nil,
		},
		{
			name: "empty fields rejected",
			rules: []kaiadv1alpha1.ManagesRule{
				{APIGroups: []string{"apps"}, Resources: nil, Verbs: []string{"get"}},
			},
			wantErrIn: "non-empty",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateManages(tc.rules)
			if tc.wantErrIn == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErrIn != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.wantErrIn)
				}
				if !strings.Contains(err.Error(), tc.wantErrIn) {
					t.Fatalf("error %q does not contain %q", err.Error(), tc.wantErrIn)
				}
			}
		})
	}
}

func TestGenerateRBAC_NamespaceScopedRule(t *testing.T) {
	rules := []kaiadv1alpha1.ManagesRule{
		{
			APIGroups: []string{"apps"},
			Resources: []string{"deployments"},
			Verbs:     []string{"get", "list", "watch", "patch", "update"},
			NamespaceSelector: &metav1.LabelSelector{
				MatchLabels: map[string]string{"kaiad.dev/managed": "true"},
			},
		},
	}
	got, err := generateRBAC(sampleAgent(rules), "edge-sa", "kaiad-system")
	if err != nil {
		t.Fatalf("generateRBAC: %v", err)
	}
	if got.ClusterRole != nil || got.ClusterRoleBinding != nil {
		t.Error("namespace-scoped rule should NOT produce a ClusterRole")
	}
	if got.Role == nil || got.RoleBinding == nil {
		t.Fatal("expected Role + RoleBinding")
	}
	if len(got.NamespaceSelectors) != 1 {
		t.Fatalf("expected 1 namespaceSelector, got %d", len(got.NamespaceSelectors))
	}
	if len(got.Role.Rules) != 1 {
		t.Fatalf("expected 1 PolicyRule, got %d", len(got.Role.Rules))
	}
	rule := got.Role.Rules[0]
	if !equalStringSlices(rule.Verbs, []string{"get", "list", "watch", "patch", "update"}) {
		t.Errorf("verbs lost: %v", rule.Verbs)
	}
	if got.RoleBinding.Subjects[0].Name != "edge-sa" || got.RoleBinding.Subjects[0].Namespace != "kaiad-system" {
		t.Errorf("subject points at wrong SA: %+v", got.RoleBinding.Subjects[0])
	}
}

func TestGenerateRBAC_ClusterScopedRule(t *testing.T) {
	rules := []kaiadv1alpha1.ManagesRule{
		{APIGroups: []string{""}, Resources: []string{"pods"}, Verbs: []string{"get", "list", "watch"}},
	}
	got, err := generateRBAC(sampleAgent(rules), "edge-sa", "kaiad-system")
	if err != nil {
		t.Fatalf("generateRBAC: %v", err)
	}
	if got.Role != nil || got.RoleBinding != nil {
		t.Error("cluster-wide rule should NOT produce a Role")
	}
	if got.ClusterRole == nil || got.ClusterRoleBinding == nil {
		t.Fatal("expected ClusterRole + binding")
	}
	if got.ClusterRoleBinding.RoleRef.Kind != "ClusterRole" {
		t.Errorf("RoleRef.Kind = %q, want ClusterRole", got.ClusterRoleBinding.RoleRef.Kind)
	}
	if got.ClusterRole.Name != got.ClusterRoleBinding.RoleRef.Name {
		t.Errorf("ClusterRoleBinding.RoleRef.Name (%q) does not match ClusterRole.Name (%q)",
			got.ClusterRoleBinding.RoleRef.Name, got.ClusterRole.Name)
	}
}

func TestGenerateRBAC_MixedScopes(t *testing.T) {
	rules := []kaiadv1alpha1.ManagesRule{
		{APIGroups: []string{"apps"}, Resources: []string{"deployments"}, Verbs: []string{"get"},
			NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"x": "y"}}},
		{APIGroups: []string{""}, Resources: []string{"events"}, Verbs: []string{"create"}}, // cluster-wide
	}
	got, err := generateRBAC(sampleAgent(rules), "edge-sa", "kaiad-system")
	if err != nil {
		t.Fatalf("generateRBAC: %v", err)
	}
	if got.Role == nil || got.ClusterRole == nil {
		t.Fatalf("expected both Role and ClusterRole; got Role=%v ClusterRole=%v", got.Role != nil, got.ClusterRole != nil)
	}
}

func TestGenerateRBAC_RejectsDisallowedRule(t *testing.T) {
	rules := []kaiadv1alpha1.ManagesRule{
		{APIGroups: []string{""}, Resources: []string{"secrets"}, Verbs: []string{"get"}},
	}
	if _, err := generateRBAC(sampleAgent(rules), "edge-sa", "kaiad-system"); err == nil {
		t.Fatal("expected validation error for secrets, got nil")
	}
}

func TestGenerateRBAC_EmptyManages(t *testing.T) {
	got, err := generateRBAC(sampleAgent(nil), "edge-sa", "kaiad-system")
	if err != nil {
		t.Fatalf("generateRBAC empty: %v", err)
	}
	if got.Role != nil || got.ClusterRole != nil {
		t.Error("empty manages should produce no RBAC objects")
	}
	if len(got.generatedObjects()) != 0 {
		t.Errorf("expected 0 generated objects, got %d", len(got.generatedObjects()))
	}
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Compile-time assertion: the rbac objects all satisfy client.Object.
var (
	_ = &rbacv1.Role{}
	_ = &rbacv1.RoleBinding{}
	_ = &rbacv1.ClusterRole{}
	_ = &rbacv1.ClusterRoleBinding{}
)
