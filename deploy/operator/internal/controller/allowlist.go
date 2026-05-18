package controller

import (
	"fmt"

	kaiadv1alpha1 "github.com/innkeeperdevops/kaiad/operator/api/v1alpha1"
)

// allowedRBAC enumerates every (apiGroup, resource) → permitted-verbs combo
// that the operator is willing to grant to a KaiadAgent's ServiceAccount.
//
// Anything outside this map is rejected by validateManages — even if a
// KaiadAgent author asks for it. The intent is that a tenant who can apply
// a KaiadAgent CR cannot use it to escalate to cluster-admin or read Secrets.
//
// Adding a row should be a deliberate decision: pair it with a justification in
// the design doc and ideally a test in rbac_test.go.
var allowedRBAC = map[string]map[string]map[string]struct{}{
	"apps": {
		// create/delete are required: the agent's redeploy_service
		// `kubectl apply`s a Deployment (create when absent, patch when
		// present) and teardown_service deletes it. Without create/delete
		// the agent can observe but never actually deploy a service.
		"deployments": {
			"get": {}, "list": {}, "watch": {}, "create": {}, "update": {}, "patch": {}, "delete": {},
		},
		"statefulsets": {
			"get": {}, "list": {}, "watch": {}, "create": {}, "update": {}, "patch": {}, "delete": {},
		},
		"daemonsets": {
			"get": {}, "list": {}, "watch": {},
		},
	},
	// Empty group string is the kubernetes core API group ("" = "core" in RBAC).
	"": {
		"pods": {
			"get": {}, "list": {}, "watch": {},
		},
		"pods/log": {
			"get": {}, "list": {}, "watch": {},
		},
		// The agent renders a Service alongside the Deployment for every
		// k8s/metallb/cluster-ip load-balancer type, and deletes it on
		// teardown — so it needs the full create/update/delete surface.
		"services": {
			"get": {}, "list": {}, "watch": {}, "create": {}, "update": {}, "patch": {}, "delete": {},
		},
		// The agent self-provisions the target namespace it deploys into
		// (resolved per-service from kaiad.yaml) so no admin has to
		// pre-create/label it. create is required for that; delete is
		// deliberately withheld (deleting a namespace nukes everything in
		// it — far beyond the agent's deploy mandate).
		"namespaces": {
			"get": {}, "list": {}, "watch": {}, "create": {},
		},
		// create ONLY — the agent writes its own image-pull Secret
		// (dockerconfigjson, built from creds it already holds) into the
		// target namespace so private Kaiad-registry images pull. No
		// get/list/watch: the agent still cannot READ any cluster Secret,
		// so the allow-list's "can't exfiltrate secrets" guarantee holds.
		"secrets": {
			"create": {},
		},
		"events": {
			"get": {}, "list": {}, "watch": {}, "create": {}, "patch": {},
		},
		"configmaps": {
			"get": {}, "list": {}, "watch": {},
		},
	},
	// nginx load-balancer type renders an Ingress instead of a
	// LoadBalancer Service; teardown deletes it. Mirrors the Service grant.
	"networking.k8s.io": {
		"ingresses": {
			"get": {}, "list": {}, "watch": {}, "create": {}, "update": {}, "patch": {}, "delete": {},
		},
	},
	"batch": {
		"jobs": {
			"get": {}, "list": {}, "watch": {}, "create": {}, "delete": {},
		},
		"cronjobs": {
			"get": {}, "list": {}, "watch": {},
		},
	},
}

// validateManages returns nil if every rule is on the allow-list, otherwise an
// error naming the first offending (group, resource, verb) tuple. Validation is
// best-first: callers should reject the whole CR on the first error rather
// than partially applying RBAC.
func validateManages(rules []kaiadv1alpha1.ManagesRule) error {
	for ri, rule := range rules {
		if len(rule.APIGroups) == 0 || len(rule.Resources) == 0 || len(rule.Verbs) == 0 {
			return fmt.Errorf("manages[%d]: apiGroups, resources, and verbs are all required and non-empty", ri)
		}
		for _, group := range rule.APIGroups {
			groupRules, ok := allowedRBAC[group]
			if !ok {
				return fmt.Errorf("manages[%d]: apiGroup %q is not on the operator's allow-list", ri, group)
			}
			for _, resource := range rule.Resources {
				resourceVerbs, ok := groupRules[resource]
				if !ok {
					return fmt.Errorf("manages[%d]: resource %q in apiGroup %q is not on the allow-list", ri, resource, group)
				}
				for _, verb := range rule.Verbs {
					if _, ok := resourceVerbs[verb]; !ok {
						return fmt.Errorf("manages[%d]: verb %q on %q/%q is not on the allow-list", ri, verb, group, resource)
					}
				}
			}
		}
	}
	return nil
}
