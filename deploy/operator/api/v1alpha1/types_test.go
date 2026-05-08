package v1alpha1

import (
	"encoding/json"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestKaiadAgentJSONRoundTrip(t *testing.T) {
	original := &KaiadAgent{
		TypeMeta: metav1.TypeMeta{Kind: "KaiadAgent", APIVersion: GroupVersion.String()},
		ObjectMeta: metav1.ObjectMeta{
			Name:      "edge-agent",
			Namespace: "kaiad-system",
		},
		Spec: KaiadAgentSpec{
			ControlPlane: ControlPlaneSpec{RealtimeURL: "wss://panel.example.com/realtime"},
			Enrollment: EnrollmentSpec{
				SecretRef: &SecretKeyRef{Name: "kaiad-enrollment", Key: "token"},
				AutoMint:  false,
			},
			ServiceID: "svc-api-1",
			Image:     "ghcr.io/innkeeperdevops/kaiad-agent:v1.2.3",
			Manages: []ManagesRule{
				{
					APIGroups:         []string{"apps"},
					Resources:         []string{"deployments"},
					Verbs:             []string{"get", "list", "watch", "patch", "update"},
					NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kaiad.dev/managed": "true"}},
				},
			},
		},
	}

	raw, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got KaiadAgent
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Spec.ControlPlane.RealtimeURL != "wss://panel.example.com/realtime" {
		t.Errorf("realtimeUrl lost: %q", got.Spec.ControlPlane.RealtimeURL)
	}
	if got.Spec.Enrollment.SecretRef == nil || got.Spec.Enrollment.SecretRef.Name != "kaiad-enrollment" {
		t.Errorf("secretRef lost: %+v", got.Spec.Enrollment.SecretRef)
	}
	if len(got.Spec.Manages) != 1 || got.Spec.Manages[0].NamespaceSelector == nil {
		t.Errorf("manages lost: %+v", got.Spec.Manages)
	}
	if got.Spec.Manages[0].NamespaceSelector.MatchLabels["kaiad.dev/managed"] != "true" {
		t.Errorf("namespaceSelector labels lost")
	}
}

func TestKaiadAgentDeepCopyDecouplesSlicesAndMaps(t *testing.T) {
	original := &KaiadAgent{
		Spec: KaiadAgentSpec{
			ControlPlane: ControlPlaneSpec{RealtimeURL: "wss://x"},
			Enrollment:   EnrollmentSpec{AutoMint: true},
			Image:        "img:1",
			NodeSelector: map[string]string{"role": "edge"},
			Tolerations:  []corev1.Toleration{{Key: "foo", Operator: corev1.TolerationOpEqual, Value: "bar"}},
			Manages: []ManagesRule{{
				APIGroups: []string{"apps"},
				Resources: []string{"deployments"},
				Verbs:     []string{"get"},
			}},
		},
	}
	clone := original.DeepCopy()

	clone.Spec.NodeSelector["role"] = "mutated"
	if original.Spec.NodeSelector["role"] != "edge" {
		t.Error("DeepCopy did not isolate NodeSelector map")
	}
	clone.Spec.Tolerations[0].Value = "mutated"
	if original.Spec.Tolerations[0].Value != "bar" {
		t.Error("DeepCopy did not isolate Tolerations slice")
	}
	clone.Spec.Manages[0].Verbs[0] = "delete"
	if original.Spec.Manages[0].Verbs[0] != "get" {
		t.Error("DeepCopy did not isolate Manages.Verbs slice")
	}
}

func TestEnrollmentSpecValidationGuidance(t *testing.T) {
	// Sanity: zero value is the "neither" case the operator must reject when
	// reconciling, not at marshal time. The CRD validation marker is on
	// AutoMint defaulting to false, so an empty struct round-trips cleanly.
	e := EnrollmentSpec{}
	if e.AutoMint {
		t.Error("AutoMint should default to false")
	}
	if e.SecretRef != nil {
		t.Error("SecretRef should default to nil")
	}
}
