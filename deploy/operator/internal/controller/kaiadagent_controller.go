// Package controller hosts the KaiadAgent reconciler.
//
// One reconcile pass:
//   1. Validate spec.manages against the allow-list.
//   2. Resolve the enrollment Secret named in spec.enrollment.secretRef.
//   3. Generate scoped RBAC (ServiceAccount + Role/ClusterRole + bindings).
//   4. Apply the agent Deployment (server-side via CreateOrUpdate).
//   5. Update status conditions: EnrollmentValid, Reconciling, Ready.
//
// Status: Ready flips to True only when (a) the Deployment reports a ready
// replica AND (b) — when an API client is configured — the Kaiad API
// confirms the agent is online. With no API client configured, Ready
// reflects pod readiness only.
package controller

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	kaiadv1alpha1 "github.com/innkeeperdevops/kaiad/operator/api/v1alpha1"
	"github.com/innkeeperdevops/kaiad/operator/internal/kaiad"
)

const (
	conditionReady          = "Ready"
	conditionEnrollment     = "EnrollmentValid"
	conditionReconciling    = "Reconciling"
	reasonInvalidSpec       = "InvalidSpec"
	reasonEnrollmentFailed  = "EnrollmentFailed"
	reasonEnrollmentReady   = "EnrollmentReady"
	reasonDeploymentPending = "DeploymentPending"
	reasonAgentOnline       = "AgentOnline"
	reasonAgentNotOnline    = "AgentNotOnline"
)

// KaiadAgentReconciler reconciles a KaiadAgent object.
type KaiadAgentReconciler struct {
	client.Client
	Scheme      *runtime.Scheme
	KaiadClient *kaiad.Client
}

// +kubebuilder:rbac:groups=kaiad.dev,resources=kaiadagents,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=kaiad.dev,resources=kaiadagents/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=kaiad.dev,resources=kaiadagents/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts;secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings;clusterroles;clusterrolebindings,verbs=get;list;watch;create;update;patch;delete

// Reconcile is the main entry point.
func (r *KaiadAgentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := ctrl.LoggerFrom(ctx).WithValues("kaiadagent", req.NamespacedName)

	agent := &kaiadv1alpha1.KaiadAgent{}
	if err := r.Get(ctx, req.NamespacedName, agent); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Validate manages first — failing here means we never create RBAC.
	if err := validateManages(agent.Spec.Manages); err != nil {
		setCondition(agent, conditionReady, metav1.ConditionFalse, reasonInvalidSpec, err.Error())
		setCondition(agent, conditionReconciling, metav1.ConditionFalse, reasonInvalidSpec, "spec invalid; not reconciling")
		return r.commitStatus(ctx, agent)
	}
	setCondition(agent, conditionReconciling, metav1.ConditionTrue, "Reconciling", "Applying desired state")

	// Resolve the enrollment Secret named in spec.enrollment.secretRef.
	// The cluster admin pre-provisioned it; the operator does not mint.
	enroll, err := resolveEnrollment(ctx, r.Client, agent)
	if err != nil {
		logger.Error(err, "enrollment resolution failed")
		setCondition(agent, conditionEnrollment, metav1.ConditionFalse, reasonEnrollmentFailed, err.Error())
		setCondition(agent, conditionReady, metav1.ConditionFalse, reasonEnrollmentFailed, "Enrollment token unavailable")
		return r.commitStatus(ctx, agent, ctrl.Result{RequeueAfter: 30 * time.Second})
	}
	setCondition(agent, conditionEnrollment, metav1.ConditionTrue, reasonEnrollmentReady, "Enrollment token available")
	// Pin the platform's enrolledAgentId to the same SM_AGENT_ID we bake into
	// the agent pod's env. Both sides are derived from the CR's UID so the CR,
	// the panel, and the pod agree on a single id without an API round-trip.
	expectedAgentID := computeAgentID(agent)
	if expectedAgentID != "" && agent.Status.EnrolledAgentID != expectedAgentID {
		agent.Status.EnrolledAgentID = expectedAgentID
	}

	// ServiceAccount — base identity.
	saName := serviceAccountName(agent)
	if err := r.applyServiceAccount(ctx, agent, saName); err != nil {
		return ctrl.Result{}, fmt.Errorf("apply service account: %w", err)
	}

	// RBAC objects (ClusterRole/ClusterRoleBinding always; Role/RoleBinding per
	// matching namespace).
	rbac, err := generateRBAC(agent, saName, agent.Namespace)
	if err != nil {
		setCondition(agent, conditionReady, metav1.ConditionFalse, reasonInvalidSpec, err.Error())
		return r.commitStatus(ctx, agent)
	}
	if err := r.applyClusterRBAC(ctx, agent, rbac); err != nil {
		return ctrl.Result{}, fmt.Errorf("apply cluster RBAC: %w", err)
	}
	if err := r.applyNamespacedRBAC(ctx, agent, rbac); err != nil {
		return ctrl.Result{}, fmt.Errorf("apply namespaced RBAC: %w", err)
	}

	// Deployment.
	dep, err := r.applyDeployment(ctx, agent, saName, enroll)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("apply deployment: %w", err)
	}
	agent.Status.DeploymentName = dep.Name
	agent.Status.ObservedGeneration = agent.Generation

	// Status: pod ready + (optional) agent online check.
	deploymentReady := dep.Status.ReadyReplicas >= 1
	if !deploymentReady {
		setCondition(agent, conditionReady, metav1.ConditionFalse, reasonDeploymentPending, "Deployment has no ready replicas yet")
		setCondition(agent, conditionReconciling, metav1.ConditionFalse, "Reconciled", "Reconciliation complete; awaiting pod readiness")
		return r.commitStatus(ctx, agent, ctrl.Result{RequeueAfter: 15 * time.Second})
	}

	online, agentInfo := r.checkAgentOnline(ctx, agent)
	switch {
	case !online:
		setCondition(agent, conditionReady, metav1.ConditionFalse, reasonAgentNotOnline, "Pod ready but control plane has not seen the agent yet")
		setCondition(agent, conditionReconciling, metav1.ConditionFalse, "Reconciled", "Awaiting first agent check-in")
		return r.commitStatus(ctx, agent, ctrl.Result{RequeueAfter: 15 * time.Second})
	default:
		if agentInfo != nil && agentInfo.ID != "" {
			agent.Status.EnrolledAgentID = agentInfo.ID
		}
		setCondition(agent, conditionReady, metav1.ConditionTrue, reasonAgentOnline, "Agent connected to the control plane")
		setCondition(agent, conditionReconciling, metav1.ConditionFalse, "Reconciled", "Reconciliation complete")
		return r.commitStatus(ctx, agent, ctrl.Result{RequeueAfter: 5 * time.Minute})
	}
}

// commitStatus writes status changes and returns the requested Result.
func (r *KaiadAgentReconciler) commitStatus(ctx context.Context, agent *kaiadv1alpha1.KaiadAgent, opt ...ctrl.Result) (ctrl.Result, error) {
	if err := r.Status().Update(ctx, agent); err != nil {
		return ctrl.Result{}, fmt.Errorf("update status: %w", err)
	}
	if len(opt) > 0 {
		return opt[0], nil
	}
	return ctrl.Result{}, nil
}

// checkAgentOnline asks the Kaiad API whether the enrolled agent is online.
// Returns (false, nil) if the API reports 404 (not yet enrolled) or any error.
func (r *KaiadAgentReconciler) checkAgentOnline(ctx context.Context, agent *kaiadv1alpha1.KaiadAgent) (bool, *kaiad.AgentInfo) {
	if agent.Status.EnrolledAgentID == "" || r.KaiadClient == nil {
		return false, nil
	}
	info, err := r.KaiadClient.GetAgent(ctx, agent.Status.EnrolledAgentID)
	if err != nil {
		return false, nil
	}
	return info.Status == "online" || info.WebsocketConnected, &info
}

// --- Apply helpers ---

func (r *KaiadAgentReconciler) applyServiceAccount(ctx context.Context, agent *kaiadv1alpha1.KaiadAgent, name string) error {
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: agent.Namespace},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, sa, func() error {
		if sa.Labels == nil {
			sa.Labels = map[string]string{}
		}
		sa.Labels["app.kubernetes.io/managed-by"] = "kaiad-operator"
		sa.Labels["kaiad.dev/agent"] = agent.Name
		return controllerutil.SetControllerReference(agent, sa, r.Scheme)
	})
	return err
}

func (r *KaiadAgentReconciler) applyClusterRBAC(ctx context.Context, agent *kaiadv1alpha1.KaiadAgent, rbac *rbacObjects) error {
	if rbac.ClusterRole == nil {
		// If a previous reconcile created a ClusterRole and the spec has changed
		// to namespace-only, garbage-collect via owner ref deletion. Owner refs
		// across namespaces aren't allowed for cluster-scoped objects, so we
		// label-select and delete explicitly.
		return r.deleteClusterRBACForAgent(ctx, agent)
	}
	cr := rbac.ClusterRole
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, cr, func() error {
		cr.Rules = rbac.ClusterRole.Rules
		// ClusterRoles cannot have namespaced owner refs; we rely on label-based
		// cleanup in the agent's finalizer (out of MVP scope) or explicit delete.
		return nil
	})
	if err != nil {
		return err
	}
	crb := rbac.ClusterRoleBinding
	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, crb, func() error {
		crb.RoleRef = rbac.ClusterRoleBinding.RoleRef
		crb.Subjects = rbac.ClusterRoleBinding.Subjects
		return nil
	})
	return err
}

func (r *KaiadAgentReconciler) deleteClusterRBACForAgent(ctx context.Context, agent *kaiadv1alpha1.KaiadAgent) error {
	cr := &rbacv1.ClusterRole{}
	if err := r.Get(ctx, types.NamespacedName{Name: clusterRoleName(agent)}, cr); err == nil {
		_ = r.Delete(ctx, cr)
	}
	crb := &rbacv1.ClusterRoleBinding{}
	if err := r.Get(ctx, types.NamespacedName{Name: clusterRoleName(agent)}, crb); err == nil {
		_ = r.Delete(ctx, crb)
	}
	return nil
}

// applyNamespacedRBAC instantiates one Role + RoleBinding per namespace
// matching any selector in `spec.manages`. We resolve selectors against the
// live namespace list in the cluster.
func (r *KaiadAgentReconciler) applyNamespacedRBAC(ctx context.Context, agent *kaiadv1alpha1.KaiadAgent, rbac *rbacObjects) error {
	if rbac.Role == nil {
		return nil
	}
	matchedNamespaces, err := r.resolveSelectorNamespaces(ctx, rbac.NamespaceSelectors)
	if err != nil {
		return err
	}
	for _, ns := range matchedNamespaces {
		role := rbac.Role.DeepCopy()
		role.Namespace = ns
		_, err := controllerutil.CreateOrUpdate(ctx, r.Client, role, func() error {
			role.Rules = rbac.Role.Rules
			return nil
		})
		if err != nil {
			return err
		}
		binding := rbac.RoleBinding.DeepCopy()
		binding.Namespace = ns
		_, err = controllerutil.CreateOrUpdate(ctx, r.Client, binding, func() error {
			binding.RoleRef = rbac.RoleBinding.RoleRef
			binding.Subjects = rbac.RoleBinding.Subjects
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// resolveSelectorNamespaces lists all namespaces matching any selector. An
// empty selector list means no namespace-scoped RBAC.
func (r *KaiadAgentReconciler) resolveSelectorNamespaces(ctx context.Context, selectors []metav1.LabelSelector) ([]string, error) {
	out := map[string]struct{}{}
	for _, sel := range selectors {
		labelSel, err := metav1.LabelSelectorAsSelector(&sel)
		if err != nil {
			return nil, fmt.Errorf("invalid namespaceSelector: %w", err)
		}
		nsList := &corev1.NamespaceList{}
		if err := r.List(ctx, nsList); err != nil {
			return nil, fmt.Errorf("list namespaces: %w", err)
		}
		for _, ns := range nsList.Items {
			if labelSel.Matches(labels.Set(ns.Labels)) {
				out[ns.Name] = struct{}{}
			}
		}
	}
	names := make([]string, 0, len(out))
	for n := range out {
		names = append(names, n)
	}
	return names, nil
}

func (r *KaiadAgentReconciler) applyDeployment(ctx context.Context, agent *kaiadv1alpha1.KaiadAgent, saName string, enroll *EnrollmentResolution) (*appsv1.Deployment, error) {
	name := agent.Name
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: agent.Namespace},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, dep, func() error {
		labels := map[string]string{
			"app.kubernetes.io/name":       "kaiad-agent",
			"app.kubernetes.io/instance":   agent.Name,
			"app.kubernetes.io/managed-by": "kaiad-operator",
			"kaiad.dev/agent":              agent.Name,
		}
		dep.Labels = labels
		dep.Spec.Selector = &metav1.LabelSelector{MatchLabels: labels}
		dep.Spec.Replicas = ptr(int32(1))
		dep.Spec.Strategy = appsv1.DeploymentStrategy{
			Type: appsv1.RollingUpdateDeploymentStrategyType,
			RollingUpdate: &appsv1.RollingUpdateDeployment{
				MaxSurge:       intStrPtr(1),
				MaxUnavailable: intStrPtr(0),
			},
		}
		dep.Spec.Template.Labels = labels
		dep.Spec.Template.Spec.ServiceAccountName = saName
		dep.Spec.Template.Spec.Containers = []corev1.Container{
			{
				Name:  "agent",
				Image: agent.Spec.Image,
				// Explicit Command so the agent image only needs the
				// binary at /usr/local/bin/agent; no ENTRYPOINT required
				// in the image (the kaiad-baked OCI bundle is built with
				// crane append on a stock alpine and skips the mutate
				// step needed to set ENTRYPOINT). Mirrors the way
				// apps/agent/Dockerfile sets ENTRYPOINT.
				Command:         []string{"/usr/local/bin/agent"},
				// :latest tags must re-pull on every pod start so new
				// agent code reaches the cluster — the kaiad image
				// re-pushes :latest on each platform restart, but the
				// cached image on the node would otherwise stick.
				// Specific tags (e.g. :0.2.0) keep PullIfNotPresent.
				ImagePullPolicy: imagePullPolicyForImage(agent.Spec.Image),
				Env:             buildAgentEnv(agent, enroll),
				VolumeMounts: []corev1.VolumeMount{
					{Name: "creds", MountPath: "/var/lib/kaiad-agent"},
				},
			},
		}
		dep.Spec.Template.Spec.Volumes = []corev1.Volume{
			{
				Name:         "creds",
				VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
			},
		}
		dep.Spec.Template.Spec.NodeSelector = agent.Spec.NodeSelector
		dep.Spec.Template.Spec.Tolerations = agent.Spec.Tolerations
		dep.Spec.Template.Spec.ImagePullSecrets = agent.Spec.ImagePullSecrets
		if agent.Spec.Resources != nil {
			dep.Spec.Template.Spec.Containers[0].Resources = *agent.Spec.Resources
		} else {
			dep.Spec.Template.Spec.Containers[0].Resources = defaultResources()
		}
		return controllerutil.SetControllerReference(agent, dep, r.Scheme)
	})
	if err != nil {
		return nil, err
	}
	return dep, nil
}

// computeAgentID derives the SM_AGENT_ID used for both the agent pod's env
// and the CR's status.enrolledAgentId. Stable across reconciles via the CR's
// UID; falls back to namespace.name pre-UID. Prefixed `kagent-` so platform
// inspection can tell operator-installed agents from manually-enrolled ones.
func computeAgentID(agent *kaiadv1alpha1.KaiadAgent) string {
	id := string(agent.UID)
	if id == "" {
		id = fmt.Sprintf("%s.%s", agent.Namespace, agent.Name)
	}
	return "kagent-" + id
}

func buildAgentEnv(agent *kaiadv1alpha1.KaiadAgent, enroll *EnrollmentResolution) []corev1.EnvVar {
	envs := []corev1.EnvVar{
		{Name: "SM_REALTIME_URL", Value: agent.Spec.ControlPlane.RealtimeURL},
		{Name: "SM_AGENT_ID", Value: computeAgentID(agent)},
		{Name: "NODE_ENV", Value: "production"},
		{Name: "SM_AGENT_RUNTIME_OVERRIDE", Value: "kubernetes"},
		{Name: "SM_AGENT_PERSIST_CREDENTIALS", Value: "1"},
		{
			Name: "SM_ENROLLMENT_TOKEN",
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: enroll.SecretName},
					Key:                  enroll.SecretKey,
					Optional:             ptr(true),
				},
			},
		},
	}
	if agent.Spec.ServiceID != "" {
		envs = append(envs, corev1.EnvVar{Name: "SM_SERVICE_ID", Value: agent.Spec.ServiceID})
	}
	// Thread the agent's image-pull Secret name through so the agent can
	// attach it to the Deployments it renders for monitored services —
	// their images live in the (private) Kaiad registry, same as the
	// agent's own image. Without this every service pod ErrImagePulls.
	if len(agent.Spec.ImagePullSecrets) > 0 && agent.Spec.ImagePullSecrets[0].Name != "" {
		envs = append(envs, corev1.EnvVar{Name: "KAIAD_IMAGE_PULL_SECRET", Value: agent.Spec.ImagePullSecrets[0].Name})
	}
	return envs
}

func defaultResources() corev1.ResourceRequirements {
	return corev1.ResourceRequirements{
		Requests: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("50m"),
			corev1.ResourceMemory: resource.MustParse("64Mi"),
		},
		Limits: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("500m"),
			corev1.ResourceMemory: resource.MustParse("256Mi"),
		},
	}
}

func serviceAccountName(agent *kaiadv1alpha1.KaiadAgent) string {
	return fmt.Sprintf("%s-agent", agent.Name)
}

func setCondition(agent *kaiadv1alpha1.KaiadAgent, condType string, status metav1.ConditionStatus, reason, message string) {
	meta.SetStatusCondition(&agent.Status.Conditions, metav1.Condition{
		Type:               condType,
		Status:             status,
		ObservedGeneration: agent.Generation,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: metav1.Time{Time: time.Now()},
	})
}

func ptr[T any](v T) *T { return &v }

func intStrPtr(i int) *intstr.IntOrString {
	v := intstr.FromInt(i)
	return &v
}

// SetupWithManager registers the controller with the manager and arranges
// reconciliation triggers from owned and watched resources.
func (r *KaiadAgentReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kaiadv1alpha1.KaiadAgent{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.ServiceAccount{}).
		Owns(&corev1.Secret{}).
		// Re-reconcile every KaiadAgent when a namespace's labels change so
		// namespace-scoped RBAC follows the selectors.
		Watches(
			&corev1.Namespace{},
			handler.EnqueueRequestsFromMapFunc(r.namespaceToAgents),
			builder.WithPredicates(),
		).
		Complete(r)
}

// imagePullPolicyForImage picks a sensible default policy: :latest tags
// pull on every pod start (the kaiad-side push-on-boot may have changed
// the manifest digest under the same tag); explicit version tags use
// IfNotPresent so node-cached images aren't redundantly fetched.
func imagePullPolicyForImage(image string) corev1.PullPolicy {
	colon := -1
	for i := len(image) - 1; i >= 0; i-- {
		if image[i] == ':' {
			colon = i
			break
		}
		if image[i] == '/' {
			break
		}
	}
	if colon < 0 || image[colon+1:] == "latest" {
		return corev1.PullAlways
	}
	return corev1.PullIfNotPresent
}

// namespaceToAgents maps a Namespace event to all KaiadAgents whose selectors
// might match the namespace. For correctness the simplest thing is to enqueue
// every agent — selector evaluation is cheap relative to apiserver round-trips.
func (r *KaiadAgentReconciler) namespaceToAgents(ctx context.Context, _ client.Object) []reconcile.Request {
	list := &kaiadv1alpha1.KaiadAgentList{}
	if err := r.List(ctx, list); err != nil {
		return nil
	}
	out := make([]reconcile.Request, 0, len(list.Items))
	for _, a := range list.Items {
		out = append(out, reconcile.Request{NamespacedName: types.NamespacedName{Name: a.Name, Namespace: a.Namespace}})
	}
	return out
}
