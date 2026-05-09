// KaiadAgent CRD types.
//
// Hand-rolled DeepCopy methods at the bottom replace `controller-gen object`
// for now; if you change a field, update the corresponding DeepCopy. The
// compile-time interface assertions at the bottom of the file will fail loudly
// if a method is missing.
package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// ControlPlaneSpec captures how the agent reaches Kaiad.
type ControlPlaneSpec struct {
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Pattern=`^wss?://.+`
	RealtimeURL string `json:"realtimeUrl"`
}

// SecretKeyRef is a typed reference to a key inside a Secret in the same namespace.
type SecretKeyRef struct {
	// +kubebuilder:validation:Required
	Name string `json:"name"`
	// +kubebuilder:default=token
	Key string `json:"key,omitempty"`
}

// EnrollmentSpec describes how the agent obtains its bootstrap enrollment token.
//
// SecretRef is required and must point at a Secret the cluster admin
// pre-provisioned with a token minted via the Kaiad panel (Settings →
// Enrollment tokens → Generate). The token's tenant binding is implicit
// (whichever tenant the panel session is in when generating); the CR itself
// never names a tenant.
//
// (Earlier revisions supported `autoMint: true` so the operator minted a
// fresh token on every reconcile via an API credential. That tied the
// operator to a single tenant via its credential — a tenant the CR could
// not name — and produced thousands of expired tokens because every
// reconcile minted anew. Removed in favor of the explicit secretRef path.)
type EnrollmentSpec struct {
	// +kubebuilder:validation:Required
	SecretRef *SecretKeyRef `json:"secretRef"`
}

// ManagesRule is one RBAC rule the agent's ServiceAccount will be granted.
//
// Operator validates these against an allow-list (see internal/controller/allowlist.go)
// before generating Roles/ClusterRoles. Anything outside the allow-list is
// rejected with status `Ready=False, Reason=InvalidSpec`.
type ManagesRule struct {
	// +kubebuilder:validation:Required
	APIGroups []string `json:"apiGroups"`
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinItems=1
	Resources []string `json:"resources"`
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinItems=1
	Verbs []string `json:"verbs"`
	// NamespaceSelector restricts the rule to namespaces matching this label
	// selector. If omitted, the rule applies cluster-wide (a ClusterRole is
	// generated). Setting an empty `{}` matches every namespace but still uses
	// per-namespace Roles, which the operator narrows on namespace events.
	NamespaceSelector *metav1.LabelSelector `json:"namespaceSelector,omitempty"`
}

// KaiadAgentSpec defines the desired state of a KaiadAgent.
type KaiadAgentSpec struct {
	// +kubebuilder:validation:Required
	ControlPlane ControlPlaneSpec `json:"controlPlane"`
	// +kubebuilder:validation:Required
	Enrollment EnrollmentSpec `json:"enrollment"`
	// Optional: pin every log frame and command from this agent to a specific
	// Kaiad service id (mirrors `SM_SERVICE_ID` in the manual flow).
	ServiceID string `json:"serviceId,omitempty"`
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Image        string                       `json:"image"`
	Resources    *corev1.ResourceRequirements `json:"resources,omitempty"`
	NodeSelector map[string]string            `json:"nodeSelector,omitempty"`
	Tolerations  []corev1.Toleration          `json:"tolerations,omitempty"`
	// ImagePullSecrets are referenced from the agent Pod's spec so kubelet
	// can authenticate against a private registry (typically Kaiad's
	// built-in token-auth registry). The panel emits a `<agent>-pull`
	// dockerconfigjson Secret alongside the enrollment Secret; this
	// field threads it onto the Pod.
	ImagePullSecrets []corev1.LocalObjectReference `json:"imagePullSecrets,omitempty"`
	// +kubebuilder:validation:MaxItems=32
	Manages []ManagesRule `json:"manages,omitempty"`
}

// KaiadAgentStatus is the observed state of a KaiadAgent.
type KaiadAgentStatus struct {
	// Conditions:
	//   - Ready             ─ True once the agent pod is ready AND the control plane
	//                         confirms the agent is online.
	//   - EnrollmentValid   ─ True once a usable bootstrap token exists.
	//   - Reconciling       ─ True while the operator is mid-apply.
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
	EnrolledAgentID    string             `json:"enrolledAgentId,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	DeploymentName     string             `json:"deploymentName,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=kagent
// +kubebuilder:printcolumn:name="Image",type=string,JSONPath=`.spec.image`
// +kubebuilder:printcolumn:name="AgentId",type=string,JSONPath=`.status.enrolledAgentId`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=='Ready')].status`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// KaiadAgent is the Schema for the kaiadagents API.
type KaiadAgent struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              KaiadAgentSpec   `json:"spec,omitempty"`
	Status            KaiadAgentStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// KaiadAgentList contains a list of KaiadAgent.
type KaiadAgentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []KaiadAgent `json:"items"`
}

func init() {
	SchemeBuilder.Register(&KaiadAgent{}, &KaiadAgentList{})
}

// --- DeepCopy methods (hand-rolled) -----------------------------------------

// DeepCopyInto copies into out, which must be non-nil.
func (in *ControlPlaneSpec) DeepCopyInto(out *ControlPlaneSpec) { *out = *in }

// DeepCopy returns a deep copy.
func (in *ControlPlaneSpec) DeepCopy() *ControlPlaneSpec {
	if in == nil {
		return nil
	}
	out := new(ControlPlaneSpec)
	in.DeepCopyInto(out)
	return out
}

func (in *SecretKeyRef) DeepCopyInto(out *SecretKeyRef) { *out = *in }
func (in *SecretKeyRef) DeepCopy() *SecretKeyRef {
	if in == nil {
		return nil
	}
	out := new(SecretKeyRef)
	in.DeepCopyInto(out)
	return out
}

func (in *EnrollmentSpec) DeepCopyInto(out *EnrollmentSpec) {
	*out = *in
	if in.SecretRef != nil {
		out.SecretRef = in.SecretRef.DeepCopy()
	}
}
func (in *EnrollmentSpec) DeepCopy() *EnrollmentSpec {
	if in == nil {
		return nil
	}
	out := new(EnrollmentSpec)
	in.DeepCopyInto(out)
	return out
}

func (in *ManagesRule) DeepCopyInto(out *ManagesRule) {
	*out = *in
	if in.APIGroups != nil {
		out.APIGroups = append([]string(nil), in.APIGroups...)
	}
	if in.Resources != nil {
		out.Resources = append([]string(nil), in.Resources...)
	}
	if in.Verbs != nil {
		out.Verbs = append([]string(nil), in.Verbs...)
	}
	if in.NamespaceSelector != nil {
		out.NamespaceSelector = in.NamespaceSelector.DeepCopy()
	}
}
func (in *ManagesRule) DeepCopy() *ManagesRule {
	if in == nil {
		return nil
	}
	out := new(ManagesRule)
	in.DeepCopyInto(out)
	return out
}

func (in *KaiadAgentSpec) DeepCopyInto(out *KaiadAgentSpec) {
	*out = *in
	in.ControlPlane.DeepCopyInto(&out.ControlPlane)
	in.Enrollment.DeepCopyInto(&out.Enrollment)
	if in.Resources != nil {
		out.Resources = in.Resources.DeepCopy()
	}
	if in.NodeSelector != nil {
		out.NodeSelector = make(map[string]string, len(in.NodeSelector))
		for k, v := range in.NodeSelector {
			out.NodeSelector[k] = v
		}
	}
	if in.Tolerations != nil {
		out.Tolerations = make([]corev1.Toleration, len(in.Tolerations))
		for i := range in.Tolerations {
			in.Tolerations[i].DeepCopyInto(&out.Tolerations[i])
		}
	}
	if in.ImagePullSecrets != nil {
		out.ImagePullSecrets = make([]corev1.LocalObjectReference, len(in.ImagePullSecrets))
		copy(out.ImagePullSecrets, in.ImagePullSecrets)
	}
	if in.Manages != nil {
		out.Manages = make([]ManagesRule, len(in.Manages))
		for i := range in.Manages {
			in.Manages[i].DeepCopyInto(&out.Manages[i])
		}
	}
}
func (in *KaiadAgentSpec) DeepCopy() *KaiadAgentSpec {
	if in == nil {
		return nil
	}
	out := new(KaiadAgentSpec)
	in.DeepCopyInto(out)
	return out
}

func (in *KaiadAgentStatus) DeepCopyInto(out *KaiadAgentStatus) {
	*out = *in
	if in.Conditions != nil {
		out.Conditions = make([]metav1.Condition, len(in.Conditions))
		for i := range in.Conditions {
			in.Conditions[i].DeepCopyInto(&out.Conditions[i])
		}
	}
}
func (in *KaiadAgentStatus) DeepCopy() *KaiadAgentStatus {
	if in == nil {
		return nil
	}
	out := new(KaiadAgentStatus)
	in.DeepCopyInto(out)
	return out
}

func (in *KaiadAgent) DeepCopyInto(out *KaiadAgent) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	in.Spec.DeepCopyInto(&out.Spec)
	in.Status.DeepCopyInto(&out.Status)
}
func (in *KaiadAgent) DeepCopy() *KaiadAgent {
	if in == nil {
		return nil
	}
	out := new(KaiadAgent)
	in.DeepCopyInto(out)
	return out
}
func (in *KaiadAgent) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	return in.DeepCopy()
}

func (in *KaiadAgentList) DeepCopyInto(out *KaiadAgentList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]KaiadAgent, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}
func (in *KaiadAgentList) DeepCopy() *KaiadAgentList {
	if in == nil {
		return nil
	}
	out := new(KaiadAgentList)
	in.DeepCopyInto(out)
	return out
}
func (in *KaiadAgentList) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	return in.DeepCopy()
}

// Compile-time interface assertions.
var (
	_ runtime.Object = (*KaiadAgent)(nil)
	_ runtime.Object = (*KaiadAgentList)(nil)
)
