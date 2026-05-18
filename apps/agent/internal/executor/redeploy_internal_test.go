package executor

import (
	"strings"
	"testing"
)

func richPayload(lbType string) map[string]interface{} {
	return map[string]interface{}{
		"commandId":   "cmd-1",
		"serviceId":   "svc-abc",
		"serviceName": "my-svc",
		"buildId":     "bld-1",
		"imageRef":    "panel.kaiad.dev/my-svc:abc123",
		"environment": "production",
		"namespace":   "prod",
		"instances":   float64(3),
		"domains": []interface{}{
			map[string]interface{}{"host": "app.example.com", "port": float64(8080), "protocol": "https"},
		},
		"loadBalancer": map[string]interface{}{
			"type":         lbType,
			"addressPool":  "pool-a",
			"ingressClass": "nginx",
			"tlsSecret":    "tls",
			"annotations":  map[string]interface{}{"a": "b"},
		},
	}
}

func TestParseRedeployPayload(t *testing.T) {
	in, err := parseRedeployPayload(richPayload("nginx"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if in.serviceID != "svc-abc" || in.imageRef == "" || in.instances != 3 {
		t.Fatalf("parsed = %+v", in)
	}
	if len(in.domains) != 1 || in.loadBalancer.typ != "nginx" {
		t.Fatalf("domains/lb = %+v", in)
	}
	if _, err := parseRedeployPayload(map[string]interface{}{}); err == nil {
		t.Fatal("missing serviceId should error")
	}
	if _, err := parseRedeployPayload(map[string]interface{}{"serviceId": "x"}); err == nil {
		t.Fatal("missing imageRef should error")
	}
	// environment defaults to development when absent.
	d, _ := parseRedeployPayload(map[string]interface{}{"serviceId": "x", "imageRef": "i:t"})
	if d.environment != "development" {
		t.Fatalf("env default = %q", d.environment)
	}
}

func TestRenderK8sManifestsAllLBTypes(t *testing.T) {
	for _, lb := range []string{"none", "k8s", "metallb", "nginx"} {
		in, err := parseRedeployPayload(richPayload(lb))
		if err != nil {
			t.Fatalf("parse %s: %v", lb, err)
		}
		yaml := renderK8sManifests(in, "prod")
		if !strings.Contains(yaml, "kind: Deployment") || !strings.Contains(yaml, "my-svc") {
			t.Fatalf("render(%s) missing core manifest:\n%s", lb, yaml[:min(len(yaml), 300)])
		}
	}
}

func TestLbStatusReportsAndHelpers(t *testing.T) {
	in, _ := parseRedeployPayload(richPayload("nginx"))
	if r := buildLbStatusReport("agent-1", in, "prod", "1.2.3.4", "h.example"); r["serviceId"] != "svc-abc" {
		t.Fatalf("lb report = %v", r)
	}
	if r := buildDockerLbStatusReport("agent-1", in, "prod", true); len(r) == 0 {
		t.Fatal("docker lb report empty")
	}
	if k8sResourceName("svc-abc", "my-svc") == "" {
		t.Fatal("k8sResourceName empty")
	}
	if k8sResourceName("svc-abc", "") == "" {
		t.Fatal("k8sResourceName fallback empty")
	}
	if shortID("abcdef1234567890") == "" || shortServiceName("svc-abc") == "" {
		t.Fatal("short helpers empty")
	}
	if upstreamPort(in.domains) != 8080 {
		t.Fatalf("upstreamPort = %d", upstreamPort(in.domains))
	}
	if len(toLBDomains(in.domains)) != 1 {
		t.Fatal("toLBDomains length")
	}
	_ = registryHostFromImageRef("panel.kaiad.dev/x:tag")
	_ = registryAuthFromEnv("panel.kaiad.dev/x:tag")
}

func TestRenderK8sManifestsMetalLBPinnedIP(t *testing.T) {
	payload := richPayload("metallb")
	lb := payload["loadBalancer"].(map[string]interface{})
	lb["addressPool"] = "first-pool"
	lb["loadBalancerIPs"] = "192.168.1.228"

	in, err := parseRedeployPayload(payload)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if in.loadBalancer.loadBalancerIPs != "192.168.1.228" {
		t.Fatalf("loadBalancerIPs not parsed: %q", in.loadBalancer.loadBalancerIPs)
	}
	yaml := renderK8sManifests(in, "prod")
	for _, want := range []string{
		"type: LoadBalancer",
		"metallb.universe.tf/loadBalancerIPs",
		"192.168.1.228",
		"metallb.universe.tf/address-pool",
	} {
		if !strings.Contains(yaml, want) {
			t.Fatalf("rendered Service missing %q in:\n%s", want, yaml)
		}
	}

	// Without loadBalancerIPs the annotation must NOT appear.
	in2, _ := parseRedeployPayload(richPayload("metallb"))
	if strings.Contains(renderK8sManifests(in2, "prod"), "loadBalancerIPs") {
		t.Fatal("loadBalancerIPs annotation emitted when unset")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
