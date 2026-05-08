package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	kaiadv1alpha1 "github.com/innkeeperdevops/kaiad/operator/api/v1alpha1"
	"github.com/innkeeperdevops/kaiad/operator/internal/kaiad"
)

func newTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatalf("scheme: %v", err)
	}
	if err := kaiadv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("scheme: %v", err)
	}
	return scheme
}

func mintingKaiadServer(t *testing.T) (*httptest.Server, *kaiad.Client) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/agents/enrollment-tokens":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"id":        "tok-1",
				"token":     "secret-token",
				"expiresAt": "2026-05-08T20:14:02Z",
				"agentId":   "agt-1",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	return srv, kaiad.NewClient(srv.URL, "cred", kaiad.WithMaxRetries(0))
}

func newAgentCR() *kaiadv1alpha1.KaiadAgent {
	return &kaiadv1alpha1.KaiadAgent{
		TypeMeta:   metav1.TypeMeta{APIVersion: kaiadv1alpha1.GroupVersion.String(), Kind: "KaiadAgent"},
		ObjectMeta: metav1.ObjectMeta{Name: "edge", Namespace: "kaiad-system", UID: "uid-1", Generation: 1},
		Spec: kaiadv1alpha1.KaiadAgentSpec{
			ControlPlane: kaiadv1alpha1.ControlPlaneSpec{RealtimeURL: "wss://panel.example/realtime"},
			Enrollment:   kaiadv1alpha1.EnrollmentSpec{AutoMint: true},
			Image:        "ghcr.io/example/kaiad-agent:v1",
			ServiceID:    "svc-api",
			Manages: []kaiadv1alpha1.ManagesRule{
				{
					APIGroups:         []string{"apps"},
					Resources:         []string{"deployments"},
					Verbs:             []string{"get", "list", "watch", "patch", "update"},
					NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kaiad.dev/managed": "true"}},
				},
				{
					APIGroups: []string{""},
					Resources: []string{"events"},
					Verbs:     []string{"create"},
				},
			},
		},
	}
}

func reconcileOnce(t *testing.T, r *KaiadAgentReconciler, ns, name string) ctrl.Result {
	t.Helper()
	res, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: name}})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	return res
}

func TestReconcile_CreatesDeploymentAndRBAC(t *testing.T) {
	scheme := newTestScheme(t)
	agent := newAgentCR()
	managedNS := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name:   "team-alpha",
		Labels: map[string]string{"kaiad.dev/managed": "true"},
	}}
	otherNS := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: "kube-system",
	}}

	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(agent, managedNS, otherNS).
		WithStatusSubresource(&kaiadv1alpha1.KaiadAgent{}).
		Build()

	srv, kClient := mintingKaiadServer(t)
	defer srv.Close()

	r := &KaiadAgentReconciler{Client: c, Scheme: scheme, KaiadClient: kClient}
	reconcileOnce(t, r, agent.Namespace, agent.Name)

	// --- Deployment ---
	dep := &appsv1.Deployment{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: agent.Name, Namespace: agent.Namespace}, dep); err != nil {
		t.Fatalf("Deployment not created: %v", err)
	}
	container := dep.Spec.Template.Spec.Containers[0]
	envs := map[string]string{}
	for _, e := range container.Env {
		envs[e.Name] = e.Value
	}
	if envs["SM_REALTIME_URL"] != "wss://panel.example/realtime" {
		t.Errorf("SM_REALTIME_URL not propagated: %v", envs)
	}
	if envs["SM_AGENT_RUNTIME_OVERRIDE"] != "kubernetes" {
		t.Errorf("expected SM_AGENT_RUNTIME_OVERRIDE=kubernetes")
	}
	if envs["SM_SERVICE_ID"] != "svc-api" {
		t.Errorf("SM_SERVICE_ID not propagated: %v", envs)
	}
	// SM_ENROLLMENT_TOKEN must come from a SecretKeyRef, not a literal value.
	var foundEnrollment bool
	for _, e := range container.Env {
		if e.Name == "SM_ENROLLMENT_TOKEN" {
			if e.ValueFrom == nil || e.ValueFrom.SecretKeyRef == nil {
				t.Error("SM_ENROLLMENT_TOKEN should resolve from a Secret, not a literal value")
			}
			foundEnrollment = true
		}
	}
	if !foundEnrollment {
		t.Error("SM_ENROLLMENT_TOKEN env var missing")
	}
	if dep.Spec.Template.Spec.ServiceAccountName != serviceAccountName(agent) {
		t.Errorf("SA name = %q, want %q", dep.Spec.Template.Spec.ServiceAccountName, serviceAccountName(agent))
	}

	// --- ServiceAccount ---
	sa := &corev1.ServiceAccount{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: serviceAccountName(agent), Namespace: agent.Namespace}, sa); err != nil {
		t.Fatalf("ServiceAccount not created: %v", err)
	}

	// --- ClusterRole + ClusterRoleBinding (from the cluster-wide events rule) ---
	cr := &rbacv1.ClusterRole{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: clusterRoleName(agent)}, cr); err != nil {
		t.Fatalf("ClusterRole not created: %v", err)
	}
	if len(cr.Rules) != 1 || cr.Rules[0].Resources[0] != "events" {
		t.Errorf("ClusterRole rules unexpected: %+v", cr.Rules)
	}

	// --- Role + RoleBinding instantiated in the matching namespace only ---
	role := &rbacv1.Role{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: roleName(agent), Namespace: "team-alpha"}, role); err != nil {
		t.Fatalf("Role in team-alpha missing: %v", err)
	}
	if err := c.Get(context.Background(), types.NamespacedName{Name: roleName(agent), Namespace: "kube-system"}, role); !apierrors.IsNotFound(err) {
		t.Errorf("Role should NOT exist in kube-system; got err=%v", err)
	}

	// --- Secret (auto-minted) ---
	sec := &corev1.Secret{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: defaultEnrollmentSecretName(agent), Namespace: agent.Namespace}, sec); err != nil {
		t.Fatalf("enrollment Secret missing: %v", err)
	}
	if string(sec.Data["token"]) != "secret-token" {
		t.Errorf("enrollment Secret value not minted: %v", sec.Data)
	}

	// --- Status: Ready false because the fake Deployment has no pods, so .Status.ReadyReplicas == 0 ---
	updated := &kaiadv1alpha1.KaiadAgent{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: agent.Name, Namespace: agent.Namespace}, updated); err != nil {
		t.Fatalf("get agent: %v", err)
	}
	if !hasCondition(updated, conditionEnrollment, metav1.ConditionTrue) {
		t.Error("EnrollmentValid=True expected")
	}
	if !hasCondition(updated, conditionReady, metav1.ConditionFalse) {
		t.Error("Ready=False expected (deployment not ready in fake client)")
	}
	// Operator pins enrolledAgentId to its locally-computed kagent-<uid> form
	// (the mint response's agentId is informational only — the agent
	// self-generates from SM_AGENT_ID). The fake CR has UID "uid-1".
	if updated.Status.EnrolledAgentID != "kagent-uid-1" {
		t.Errorf("EnrolledAgentID = %q, want kagent-uid-1", updated.Status.EnrolledAgentID)
	}
	if updated.Status.DeploymentName != agent.Name {
		t.Errorf("DeploymentName = %q, want %q", updated.Status.DeploymentName, agent.Name)
	}
}

func TestReconcile_RejectsDisallowedManages(t *testing.T) {
	scheme := newTestScheme(t)
	agent := newAgentCR()
	agent.Spec.Manages = []kaiadv1alpha1.ManagesRule{
		{APIGroups: []string{""}, Resources: []string{"secrets"}, Verbs: []string{"get"}},
	}

	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(agent).
		WithStatusSubresource(&kaiadv1alpha1.KaiadAgent{}).
		Build()

	srv, kClient := mintingKaiadServer(t)
	defer srv.Close()
	r := &KaiadAgentReconciler{Client: c, Scheme: scheme, KaiadClient: kClient}

	reconcileOnce(t, r, agent.Namespace, agent.Name)

	updated := &kaiadv1alpha1.KaiadAgent{}
	_ = c.Get(context.Background(), types.NamespacedName{Name: agent.Name, Namespace: agent.Namespace}, updated)
	if !hasCondition(updated, conditionReady, metav1.ConditionFalse) {
		t.Error("Ready should be False with InvalidSpec")
	}
	cond := findCondition(updated, conditionReady)
	if cond == nil || cond.Reason != reasonInvalidSpec {
		t.Errorf("expected InvalidSpec reason, got %+v", cond)
	}

	// No Deployment, no ServiceAccount should exist.
	dep := &appsv1.Deployment{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: agent.Name, Namespace: agent.Namespace}, dep); !apierrors.IsNotFound(err) {
		t.Errorf("Deployment should not exist; got err=%v", err)
	}
}

func TestReconcile_PreProvisionedSecretIsRespected(t *testing.T) {
	scheme := newTestScheme(t)
	agent := newAgentCR()
	agent.Spec.Enrollment = kaiadv1alpha1.EnrollmentSpec{
		AutoMint:  false,
		SecretRef: &kaiadv1alpha1.SecretKeyRef{Name: "my-token", Key: "tok"},
	}
	preProvisioned := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "my-token", Namespace: agent.Namespace},
		Data:       map[string][]byte{"tok": []byte("preset")},
	}

	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(agent, preProvisioned).
		WithStatusSubresource(&kaiadv1alpha1.KaiadAgent{}).
		Build()

	// Server that PANICS if MintEnrollmentToken is called — the operator must
	// not mint when SecretRef points at a populated Secret.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected mint request when SecretRef is provided: %s", r.URL.Path)
		http.Error(w, "should not be called", http.StatusInternalServerError)
	}))
	defer srv.Close()
	r := &KaiadAgentReconciler{Client: c, Scheme: scheme, KaiadClient: kaiad.NewClient(srv.URL, "x", kaiad.WithMaxRetries(0))}

	reconcileOnce(t, r, agent.Namespace, agent.Name)

	dep := &appsv1.Deployment{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: agent.Name, Namespace: agent.Namespace}, dep); err != nil {
		t.Fatalf("Deployment missing: %v", err)
	}
	for _, e := range dep.Spec.Template.Spec.Containers[0].Env {
		if e.Name == "SM_ENROLLMENT_TOKEN" {
			if e.ValueFrom == nil || e.ValueFrom.SecretKeyRef.Name != "my-token" || e.ValueFrom.SecretKeyRef.Key != "tok" {
				t.Errorf("SecretKeyRef wrong: %+v", e.ValueFrom)
			}
			return
		}
	}
	t.Error("SM_ENROLLMENT_TOKEN env var missing")
}

func TestReconcile_NotFoundIsNoOp(t *testing.T) {
	scheme := newTestScheme(t)
	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	srv, kClient := mintingKaiadServer(t)
	defer srv.Close()
	r := &KaiadAgentReconciler{Client: c, Scheme: scheme, KaiadClient: kClient}
	res, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Name: "missing", Namespace: "ns"}})
	if err != nil {
		t.Fatalf("expected nil error for missing CR, got %v", err)
	}
	if res.RequeueAfter != 0 {
		t.Errorf("expected no requeue, got %v", res.RequeueAfter)
	}
}

func hasCondition(agent *kaiadv1alpha1.KaiadAgent, condType string, status metav1.ConditionStatus) bool {
	c := findCondition(agent, condType)
	return c != nil && c.Status == status
}

func findCondition(agent *kaiadv1alpha1.KaiadAgent, condType string) *metav1.Condition {
	for i := range agent.Status.Conditions {
		if agent.Status.Conditions[i].Type == condType {
			return &agent.Status.Conditions[i]
		}
	}
	return nil
}

// Compile-time guard against unused imports in newer Go versions.
var _ client.Client = fake.NewClientBuilder().Build()
