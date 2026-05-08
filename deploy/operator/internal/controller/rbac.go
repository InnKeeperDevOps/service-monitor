package controller

import (
	"fmt"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	kaiadv1alpha1 "github.com/innkeeperdevops/kaiad/operator/api/v1alpha1"
)

// rbacObjects is the bundle of objects generated for a KaiadAgent. The
// reconciler applies them all under owner refs to the CR. Order matters: SA
// before Roles before RoleBindings.
type rbacObjects struct {
	ServiceAccount      *rbacObjSA
	ClusterRole         *rbacv1.ClusterRole
	ClusterRoleBinding  *rbacv1.ClusterRoleBinding
	Role                *rbacv1.Role // when at least one rule has a non-nil namespaceSelector
	RoleBinding         *rbacv1.RoleBinding
	NamespaceSelectors  []metav1.LabelSelector // copies of selectors used by Role rules; reconciler watches namespaces against these
}

// rbacObjSA is a thin wrapper so we don't pull corev1 just for a SA struct here.
// The reconciler constructs the actual *corev1.ServiceAccount; we hold the
// minimum the generator needs (name, namespace, owner annotation).
type rbacObjSA struct {
	Name      string
	Namespace string
}

// generateRBAC validates the CR's `manages` rules and produces RBAC objects.
//
// Cluster-wide rules (no namespaceSelector) collapse into a single ClusterRole
// + ClusterRoleBinding. Namespace-scoped rules collapse into one Role +
// RoleBinding *per managed namespace*; the reconciler is responsible for
// resolving the LabelSelector against live namespaces and instantiating those
// per-namespace, but the rule list itself is built here so the generator stays
// pure (testable without a kube client).
//
// `namespace` is the namespace the operator places the agent's ServiceAccount
// in (typically the CR's namespace).
//
// Mutually exclusive: cluster-wide rules go to ClusterRole; selector-bearing
// rules go to (namespaced) Role(s). They cannot share an object because Role
// can't reference cross-namespace resources.
func generateRBAC(agent *kaiadv1alpha1.KaiadAgent, saName, namespace string) (*rbacObjects, error) {
	if err := validateManages(agent.Spec.Manages); err != nil {
		return nil, err
	}

	out := &rbacObjects{
		ServiceAccount: &rbacObjSA{Name: saName, Namespace: namespace},
	}

	var clusterRules []rbacv1.PolicyRule
	var nsRules []rbacv1.PolicyRule
	for _, rule := range agent.Spec.Manages {
		policy := rbacv1.PolicyRule{
			APIGroups: append([]string(nil), rule.APIGroups...),
			Resources: append([]string(nil), rule.Resources...),
			Verbs:     append([]string(nil), rule.Verbs...),
		}
		if rule.NamespaceSelector == nil {
			clusterRules = append(clusterRules, policy)
		} else {
			nsRules = append(nsRules, policy)
			out.NamespaceSelectors = append(out.NamespaceSelectors, *rule.NamespaceSelector)
		}
	}

	if len(clusterRules) > 0 {
		out.ClusterRole = &rbacv1.ClusterRole{
			ObjectMeta: metav1.ObjectMeta{
				Name: clusterRoleName(agent),
				Labels: map[string]string{
					"app.kubernetes.io/managed-by":      "kaiad-operator",
					"kaiad.dev/agent":                   agent.Name,
					"kaiad.dev/agent-namespace":         agent.Namespace,
				},
			},
			Rules: clusterRules,
		}
		out.ClusterRoleBinding = &rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{
				Name: clusterRoleName(agent),
				Labels: map[string]string{
					"app.kubernetes.io/managed-by":      "kaiad-operator",
					"kaiad.dev/agent":                   agent.Name,
					"kaiad.dev/agent-namespace":         agent.Namespace,
				},
			},
			RoleRef: rbacv1.RoleRef{
				APIGroup: rbacv1.GroupName,
				Kind:     "ClusterRole",
				Name:     out.ClusterRole.Name,
			},
			Subjects: []rbacv1.Subject{{
				Kind:      rbacv1.ServiceAccountKind,
				Name:      saName,
				Namespace: namespace,
			}},
		}
	}

	if len(nsRules) > 0 {
		// Single namespaced Role template; the reconciler will instantiate one
		// copy per matching namespace using this rule set.
		out.Role = &rbacv1.Role{
			ObjectMeta: metav1.ObjectMeta{
				Name: roleName(agent),
				Labels: map[string]string{
					"app.kubernetes.io/managed-by": "kaiad-operator",
					"kaiad.dev/agent":              agent.Name,
				},
			},
			Rules: nsRules,
		}
		out.RoleBinding = &rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{
				Name: roleName(agent),
				Labels: map[string]string{
					"app.kubernetes.io/managed-by": "kaiad-operator",
					"kaiad.dev/agent":              agent.Name,
				},
			},
			RoleRef: rbacv1.RoleRef{
				APIGroup: rbacv1.GroupName,
				Kind:     "Role",
				Name:     out.Role.Name,
			},
			Subjects: []rbacv1.Subject{{
				Kind:      rbacv1.ServiceAccountKind,
				Name:      saName,
				Namespace: namespace,
			}},
		}
	}

	return out, nil
}

func clusterRoleName(agent *kaiadv1alpha1.KaiadAgent) string {
	return fmt.Sprintf("kaiad-agent-%s-%s", agent.Namespace, agent.Name)
}

func roleName(agent *kaiadv1alpha1.KaiadAgent) string {
	return fmt.Sprintf("kaiad-agent-%s", agent.Name)
}

// generatedObjects flattens the bundle into a list the reconciler can apply.
// Useful for tests.
func (o *rbacObjects) generatedObjects() []client.Object {
	out := []client.Object{}
	if o.ClusterRole != nil {
		out = append(out, o.ClusterRole)
	}
	if o.ClusterRoleBinding != nil {
		out = append(out, o.ClusterRoleBinding)
	}
	if o.Role != nil {
		out = append(out, o.Role)
	}
	if o.RoleBinding != nil {
		out = append(out, o.RoleBinding)
	}
	return out
}
