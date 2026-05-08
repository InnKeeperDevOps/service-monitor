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
		"deployments": {
			"get": {}, "list": {}, "watch": {}, "patch": {}, "update": {},
		},
		"statefulsets": {
			"get": {}, "list": {}, "watch": {}, "patch": {}, "update": {},
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
		"events": {
			"get": {}, "list": {}, "watch": {}, "create": {}, "patch": {},
		},
		"configmaps": {
			"get": {}, "list": {}, "watch": {},
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
