package executor

// redeploy_service handler. Platform side dispatches one of these per
// bound agent after a manual build succeeds, with the per-environment
// resolved deployment metadata (instances, domains, loadBalancer).
//
// Backends:
//   docker     — pull image; stop+remove old containers labeled with
//                this service id; create+start `instances` new ones.
//                Port-publishes to the host when instances == 1
//                (multi-replica needs a fronting LB which is the
//                loadBalancer's job — out of v1 docker scope).
//   kubernetes — render Deployment/Service/Ingress YAML and
//                `kubectl apply`. Uses the in-cluster service-account
//                token; the operator grants the SA the necessary verbs
//                (apps/Deployment, /Service, networking.k8s.io/Ingress).
//   shell      — not supported; nothing to deploy onto.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/service-monitor/agent/internal/docker"
)

// LabelServiceID is set on every container the agent creates so a future
// redeploy can find and clean up its own previous replicas without
// touching containers it didn't create.
const LabelServiceID = "kaiad.dev/service-id"
const LabelBuildID = "kaiad.dev/build-id"
const LabelEnvironment = "kaiad.dev/environment"
const LabelNamespace = "kaiad.dev/namespace"

// DefaultDockerNamespace is the docker-mode fallback when kaiad.yaml
// declares no namespace. Used as the container-name prefix and label
// so kaiad-managed containers cluster naturally in `docker ps`.
const DefaultDockerNamespace = "kaiad"

type redeployInput struct {
	commandID    string
	serviceID    string
	buildID      string
	environment  string
	// namespace is the k8s namespace for k8s mode or the docker
	// "project name" for docker mode. Empty means "use the runtime's
	// default" (k8s: agent pod's own ns; docker: "kaiad").
	namespace    string
	imageRef     string
	instances    int
	domains      []domainSpec
	loadBalancer loadBalancerSpec
}

type domainSpec struct {
	host     string
	port     int
	protocol string // "http" | "https"
}

type loadBalancerSpec struct {
	typ          string            // "none" | "k8s" | "metallb" | "nginx"
	annotations  map[string]string // type=k8s
	addressPool  string            // type=metallb
	ingressClass string            // type=nginx
	tlsSecret    string            // type=nginx
}

// parseRedeployPayload pulls fields out of the loosely-typed JSON map
// the transport hands us. We tolerate missing optional fields (they
// fall back to safe defaults) and surface a single error string for
// any required field we couldn't read.
func parseRedeployPayload(payload map[string]interface{}) (redeployInput, error) {
	in := redeployInput{instances: 1, loadBalancer: loadBalancerSpec{typ: "none"}}
	if s, ok := payload["commandId"].(string); ok {
		in.commandID = s
	}
	if s, ok := payload["serviceId"].(string); ok {
		in.serviceID = s
	} else {
		return in, fmt.Errorf("payload missing serviceId")
	}
	if s, ok := payload["buildId"].(string); ok {
		in.buildID = s
	}
	if s, ok := payload["imageRef"].(string); ok && s != "" {
		in.imageRef = s
	} else {
		return in, fmt.Errorf("payload missing imageRef")
	}
	if s, ok := payload["environment"].(string); ok && s != "" {
		in.environment = s
	} else {
		in.environment = "development"
	}
	if s, ok := payload["namespace"].(string); ok {
		in.namespace = s
	}
	if n, ok := payload["instances"].(float64); ok && n >= 0 {
		in.instances = int(n)
	}
	if raw, ok := payload["domains"].([]interface{}); ok {
		for _, item := range raw {
			m, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			d := domainSpec{}
			if s, ok := m["host"].(string); ok {
				d.host = s
			}
			if n, ok := m["port"].(float64); ok {
				d.port = int(n)
			}
			if s, ok := m["protocol"].(string); ok {
				d.protocol = s
			}
			if d.host != "" && d.port > 0 {
				in.domains = append(in.domains, d)
			}
		}
	}
	if raw, ok := payload["loadBalancer"].(map[string]interface{}); ok {
		if s, ok := raw["type"].(string); ok && s != "" {
			in.loadBalancer.typ = s
		}
		if s, ok := raw["addressPool"].(string); ok {
			in.loadBalancer.addressPool = s
		}
		if s, ok := raw["ingressClass"].(string); ok {
			in.loadBalancer.ingressClass = s
		}
		if s, ok := raw["tlsSecret"].(string); ok {
			in.loadBalancer.tlsSecret = s
		}
		if anns, ok := raw["annotations"].(map[string]interface{}); ok {
			in.loadBalancer.annotations = make(map[string]string, len(anns))
			for k, v := range anns {
				if s, ok := v.(string); ok {
					in.loadBalancer.annotations[k] = s
				}
			}
		}
	}
	return in, nil
}

// executeRedeployService is the entry point — dispatches by runtime backend.
func (e *Executor) executeRedeployService(
	ctx context.Context,
	backend RuntimeBackend,
	dc *docker.Client,
	payload map[string]interface{},
) CommandResult {
	in, err := parseRedeployPayload(payload)
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("redeploy_service: %v", err)}
	}
	log.Printf(
		"[agent:executor] redeploy_service backend=%s service=%s image=%s instances=%d env=%s build=%s",
		backend, in.serviceID, in.imageRef, in.instances, in.environment, in.buildID,
	)
	switch backend {
	case RuntimeDocker:
		return e.redeployDocker(ctx, dc, in)
	case RuntimeKubernetes:
		return e.redeployKubernetes(ctx, in)
	case RuntimeShell:
		return CommandResult{
			Success: false,
			Output:  "redeploy_service: shell runtime is observation-only — nothing to deploy onto",
		}
	default:
		return CommandResult{
			Success: false,
			Output:  fmt.Sprintf("redeploy_service: unsupported runtime backend %q", backend),
		}
	}
}

// ── docker mode ──────────────────────────────────────────────────────────

func (e *Executor) redeployDocker(
	ctx context.Context,
	dc *docker.Client,
	in redeployInput,
) CommandResult {
	if dc == nil {
		return CommandResult{Success: false, Output: "redeploy_service: docker client unavailable"}
	}
	var out strings.Builder
	logf := func(format string, args ...any) {
		fmt.Fprintf(&out, format+"\n", args...)
		log.Printf("[agent:redeploy] "+format, args...)
	}

	// 1) Pull the new image. The kaiad registry needs basic auth — we
	// use admin:dev-token in dev compose and a configurable credential
	// in production via KAIAD_REGISTRY_USER / KAIAD_REGISTRY_PASSWORD.
	auth := registryAuthFromEnv(in.imageRef)
	logf("pulling %s", in.imageRef)
	if err := dc.PullImage(ctx, in.imageRef, auth); err != nil {
		return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("pull failed: %v\n", err)}
	}
	logf("pulled %s", in.imageRef)

	namespace := strings.TrimSpace(in.namespace)
	if namespace == "" {
		namespace = DefaultDockerNamespace
	}

	// 2) Find this service's existing containers and remove them.
	//    Scope by (service-id, namespace) so two services using the
	//    same id in different namespaces don't trample each other.
	existing, err := dc.ListContainersAll(ctx)
	if err != nil {
		return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("list containers: %v\n", err)}
	}
	var toRemove []docker.ContainerInfo
	for _, c := range existing {
		if c.Labels[LabelServiceID] == in.serviceID && c.Labels[LabelNamespace] == namespace {
			toRemove = append(toRemove, c)
		}
	}
	for _, c := range toRemove {
		logf("removing previous replica %s (%s)", shortID(c.ID), c.Image)
		if err := dc.RemoveContainer(ctx, c.ID); err != nil {
			return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("remove %s: %v\n", c.ID, err)}
		}
	}

	// 3) Create + start new replicas. Port publishing is only safe when
	// instances == 1 (multiple replicas would collide on the same host
	// port). For multi-replica, the user is expected to front the
	// service with a load balancer, which is the loadBalancer's job —
	// not implemented for docker mode in v1.
	publishPorts := in.instances == 1
	if !publishPorts && len(in.domains) > 0 {
		logf("instances=%d > 1; skipping host port publishing (set up an external LB)", in.instances)
	}

	var ports []docker.PortBinding
	if publishPorts {
		seen := map[int]bool{}
		for _, d := range in.domains {
			if seen[d.port] {
				continue
			}
			seen[d.port] = true
			ports = append(ports, docker.PortBinding{
				ContainerPort: d.port,
				HostPort:      d.port,
				Protocol:      "tcp",
			})
		}
	}

	labels := map[string]string{
		LabelServiceID:   in.serviceID,
		LabelBuildID:     in.buildID,
		LabelEnvironment: in.environment,
		LabelNamespace:   namespace,
	}

	for i := 0; i < in.instances; i++ {
		// <namespace>-<svc-uuid-short>-<replica> so all containers in
		// one namespace cluster in `docker ps` and the namespace
		// shows up in the container name.
		name := fmt.Sprintf("%s-%s-%d", namespace, shortServiceName(in.serviceID), i)
		// docker create rejects names that already exist; remove any
		// stale name from a prior run that wasn't caught by label scan.
		_ = dc.RemoveContainer(ctx, name)
		id, err := dc.CreateContainer(ctx, docker.CreateContainerOpts{
			Name:    name,
			Image:   in.imageRef,
			Labels:  labels,
			Ports:   ports,
			Restart: "unless-stopped",
		})
		if err != nil {
			return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("create %s: %v\n", name, err)}
		}
		if err := dc.StartContainer(ctx, id); err != nil {
			return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("start %s: %v\n", name, err)}
		}
		logf("started %s (%s)", name, shortID(id))
	}

	// Report the per-service endpoint to the platform so the panel's
	// Load Balancers page can show domain → host:port for docker
	// agents too. Docker mode has no cluster-side LB; the "external
	// endpoint" is the docker host itself, surfaced via
	// KAIAD_AGENT_EXTERNAL_HOST or os.Hostname() as a fallback.
	reporter, agentID := e.reporterAndID()
	if reporter != nil {
		report := buildDockerLbStatusReport(agentID, in, namespace, publishPorts)
		if err := reporter(report); err != nil {
			fmt.Fprintf(&out, "lb_status_report send failed: %v\n", err)
		}
	}

	return CommandResult{
		Success: true,
		Output: out.String() +
			fmt.Sprintf("redeploy ok: %d replica(s) running %s\n", in.instances, in.imageRef),
	}
}

// buildDockerLbStatusReport mirrors the k8s-mode reporter for docker
// agents. The "external endpoint" is the docker host:
//   - KAIAD_AGENT_EXTERNAL_HOST env var if the operator set it (the
//     stable answer — e.g. "edge-01.example.com" or "203.0.113.5")
//   - else os.Hostname() (best-effort; what the kernel reports)
//
// Domains are emitted only when port-publishing happened (instances=1)
// since multi-replica docker has no fronting LB by default and the
// kaiad.yaml domains have nothing to actually route to until one is
// added externally.
func buildDockerLbStatusReport(agentID string, in redeployInput, namespace string, publishedPorts bool) map[string]interface{} {
	host := strings.TrimSpace(os.Getenv("KAIAD_AGENT_EXTERNAL_HOST"))
	if host == "" {
		if hn, err := os.Hostname(); err == nil {
			host = hn
		}
	}
	var hostField interface{} = nil
	if host != "" {
		hostField = host
	}

	domains := make([]map[string]interface{}, 0, len(in.domains))
	if publishedPorts {
		for _, d := range in.domains {
			domains = append(domains, map[string]interface{}{
				"host":     d.host,
				"port":     d.port,
				"protocol": d.protocol,
			})
		}
	}

	seen := map[int]bool{}
	ports := make([]map[string]interface{}, 0)
	if publishedPorts {
		for _, d := range in.domains {
			if seen[d.port] {
				continue
			}
			seen[d.port] = true
			ports = append(ports, map[string]interface{}{
				"port":       d.port,
				"protocol":   "TCP",
				"targetPort": d.port,
			})
		}
	}

	detail := map[string]interface{}{}
	if !publishedPorts && in.instances > 1 {
		detail["note"] = fmt.Sprintf(
			"docker host-port publish skipped (instances=%d > 1); set up an external LB to route to these replicas",
			in.instances,
		)
	}

	return map[string]interface{}{
		"type":             "lb_status_report",
		"agentId":          agentID,
		"ts":               time.Now().UTC().Format(time.RFC3339Nano),
		"serviceId":        in.serviceID,
		"environment":      in.environment,
		"namespace":        namespace,
		"buildId":          in.buildID,
		"imageRef":         in.imageRef,
		// Docker doesn't have a "type" in the k8s sense; use the
		// kaiad.yaml-declared lbType so the panel groups consistently
		// (most docker services declare "none").
		"lbType":           in.loadBalancer.typ,
		"externalIp":       nil,
		"externalHostname": hostField,
		"ports":            ports,
		"domains":          domains,
		"detail":           detail,
	}
}

func registryAuthFromEnv(imageRef string) *docker.RegistryAuth {
	user := os.Getenv("KAIAD_REGISTRY_USER")
	pass := os.Getenv("KAIAD_REGISTRY_PASSWORD")
	if user == "" {
		// Dev shortcut. The kaiad registry's /registry/token endpoint
		// accepts admin:dev-token in non-production.
		user = "admin"
		pass = "dev-token"
	}
	srv := registryHostFromImageRef(imageRef)
	return &docker.RegistryAuth{Username: user, Password: pass, ServerAddress: srv}
}

func registryHostFromImageRef(ref string) string {
	// e.g. "panel.dev.kaiad.dev/foo:bar" → "panel.dev.kaiad.dev"
	slash := strings.IndexByte(ref, '/')
	if slash < 0 {
		return ""
	}
	return ref[:slash]
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func shortServiceName(serviceID string) string {
	// First 8 hex chars of the UUID is unique enough for container naming.
	if len(serviceID) > 8 {
		return serviceID[:8]
	}
	return serviceID
}

// ── kubernetes mode ──────────────────────────────────────────────────────

// redeployKubernetes renders Deployment + Service + (optional) Ingress
// manifests and applies them via `kubectl`. The agent's pod is expected
// to ship with kubectl on PATH and a service account that has
// create/update verbs on apps/Deployment, /Service, and
// networking.k8s.io/Ingress — both wired by the operator.
func (e *Executor) redeployKubernetes(ctx context.Context, in redeployInput) CommandResult {
	if _, err := exec.LookPath("kubectl"); err != nil {
		return CommandResult{
			Success: false,
			Output:  "redeploy_service: kubectl not found on PATH (is the agent image up to date?)",
		}
	}

	// Namespace selection priority: kaiad.yaml-resolved (in.namespace) →
	// KAIAD_AGENT_NAMESPACE env → in-cluster service-account ns →
	// "default". The yaml-resolved value lets a single agent deploy
	// services into multiple namespaces based on their environment.
	namespace := strings.TrimSpace(in.namespace)
	if namespace == "" {
		namespace = os.Getenv("KAIAD_AGENT_NAMESPACE")
	}
	if namespace == "" {
		// Standard in-cluster path.
		if b, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace"); err == nil {
			namespace = strings.TrimSpace(string(b))
		}
	}
	if namespace == "" {
		namespace = "default"
	}

	// Make sure the namespace exists. `kubectl create ns --dry-run=client
	// -o yaml | kubectl apply -f -` is idempotent — apply is a no-op
	// when the ns already exists, and creates it when it doesn't.
	// Failure here isn't fatal; the subsequent apply will surface a
	// clearer error if the namespace doesn't exist and we couldn't
	// create it (e.g. agent SA lacks namespaces.create cluster perm).
	ensureCtx, ensureCancel := context.WithTimeout(ctx, 10*time.Second)
	dryRun := exec.CommandContext(ensureCtx, "kubectl", "create", "ns", namespace, "--dry-run=client", "-o", "yaml")
	dryOut, dryErr := dryRun.Output()
	ensureCancel()
	if dryErr == nil {
		applyCtx, applyCancel := context.WithTimeout(ctx, 10*time.Second)
		applyNs := exec.CommandContext(applyCtx, "kubectl", "apply", "-f", "-")
		applyNs.Stdin = strings.NewReader(string(dryOut))
		_, _ = applyNs.CombinedOutput()
		applyCancel()
	}

	yaml := renderK8sManifests(in, namespace)

	// Stage to a tmpfile and `kubectl apply -f`. Stays simpler than
	// piping stdin and keeps the manifest visible in the agent log on
	// failure.
	dir, err := os.MkdirTemp("", "kaiad-redeploy-")
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("redeploy_service: mkdir tmp: %v", err)}
	}
	defer os.RemoveAll(dir)
	manifestPath := filepath.Join(dir, "manifests.yaml")
	if err := os.WriteFile(manifestPath, []byte(yaml), 0o600); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("redeploy_service: write manifest: %v", err)}
	}

	var out strings.Builder
	out.WriteString("rendered manifests:\n")
	out.WriteString(yaml)
	out.WriteString("\n")

	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	// Push the lb_status_report unconditionally on the way out — even
	// when kubectl apply / get fails. This gives the panel's Load
	// Balancers page a row with the configured slice (lbType, ports,
	// domains, namespace) so operators can see WHAT they tried to
	// deploy without waiting for a successful round-trip. externalIp
	// and externalHostname stay nil (rendered as "(pending)") when
	// the cluster hasn't actually assigned them.
	resourceName := k8sName(in.serviceID)
	var externalIP, externalHostname string
	defer func() {
		reporter, agentID := e.reporterAndID()
		if reporter == nil {
			return
		}
		report := buildLbStatusReport(agentID, in, namespace, externalIP, externalHostname)
		if err := reporter(report); err != nil {
			// Best-effort. We've already returned the CommandResult
			// to the transport at this point so the agent log is the
			// best place to surface the failure.
			log.Printf("[agent:executor] lb_status_report send failed: %v", err)
		}
	}()

	cmd := exec.CommandContext(cctx, "kubectl", "apply", "-n", namespace, "-f", manifestPath)
	combined, err := cmd.CombinedOutput()
	out.Write(combined)
	if err != nil {
		return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("\nkubectl apply: %v\n", err)}
	}

	externalIP, externalHostname = queryK8sLbAddress(cctx, namespace, in.loadBalancer.typ, resourceName)

	if externalIP != "" || externalHostname != "" {
		fmt.Fprintf(&out, "\nlb endpoint: %s%s\n", externalIP, externalHostname)
	} else {
		out.WriteString("\nlb endpoint: (pending; cluster has not assigned an IP yet)\n")
	}
	return CommandResult{Success: true, Output: out.String() + "redeploy ok\n"}
}

// queryK8sLbAddress reads the Service/Ingress that redeployKubernetes
// just applied and pulls out the assigned external IP / hostname from
// status.loadBalancer.ingress. Returns ("", "") for the type=none /
// type=cluster-ip cases or when nothing has been assigned yet.
//
// For nginx, the per-service Service stays ClusterIP; the address we
// want is the Ingress's controller endpoint, so we read the Ingress
// instead.
func queryK8sLbAddress(ctx context.Context, namespace, lbType, name string) (string, string) {
	var resource string
	switch lbType {
	case "k8s", "metallb":
		resource = "svc"
	case "nginx":
		resource = "ingress"
	default:
		return "", ""
	}
	cmd := exec.CommandContext(ctx, "kubectl", "get", resource, name, "-n", namespace, "-o", "json")
	out, err := cmd.Output()
	if err != nil {
		return "", ""
	}
	var parsed struct {
		Status struct {
			LoadBalancer struct {
				Ingress []struct {
					IP       string `json:"ip"`
					Hostname string `json:"hostname"`
				} `json:"ingress"`
			} `json:"loadBalancer"`
		} `json:"status"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return "", ""
	}
	if len(parsed.Status.LoadBalancer.Ingress) == 0 {
		return "", ""
	}
	first := parsed.Status.LoadBalancer.Ingress[0]
	return first.IP, first.Hostname
}

// buildLbStatusReport assembles the JSON payload the platform expects
// to see on the realtime channel as msg.type = "lb_status_report".
// Fields mirror the lbStatusReportSchema in @sm/contracts.
func buildLbStatusReport(agentID string, in redeployInput, namespace, externalIP, externalHostname string) map[string]interface{} {
	domains := make([]map[string]interface{}, 0, len(in.domains))
	for _, d := range in.domains {
		domains = append(domains, map[string]interface{}{
			"host":     d.host,
			"port":     d.port,
			"protocol": d.protocol,
		})
	}
	// Deduplicate ports the same way renderK8sManifests does.
	seen := map[int]bool{}
	ports := make([]map[string]interface{}, 0)
	for _, d := range in.domains {
		if seen[d.port] {
			continue
		}
		seen[d.port] = true
		ports = append(ports, map[string]interface{}{
			"port":       d.port,
			"protocol":   "TCP",
			"targetPort": d.port,
		})
	}

	detail := map[string]interface{}{}
	switch in.loadBalancer.typ {
	case "metallb":
		if in.loadBalancer.addressPool != "" {
			detail["addressPool"] = in.loadBalancer.addressPool
		}
	case "nginx":
		ingressClass := in.loadBalancer.ingressClass
		if ingressClass == "" {
			ingressClass = "nginx"
		}
		detail["ingressClass"] = ingressClass
		if in.loadBalancer.tlsSecret != "" {
			detail["tlsSecret"] = in.loadBalancer.tlsSecret
		}
	case "k8s":
		if len(in.loadBalancer.annotations) > 0 {
			detail["annotations"] = in.loadBalancer.annotations
		}
	}

	var ip interface{} = nil
	var host interface{} = nil
	if externalIP != "" {
		ip = externalIP
	}
	if externalHostname != "" {
		host = externalHostname
	}

	return map[string]interface{}{
		"type":             "lb_status_report",
		"agentId":          agentID,
		"ts":               time.Now().UTC().Format(time.RFC3339Nano),
		"serviceId":        in.serviceID,
		"environment":      in.environment,
		"namespace":        namespace,
		"buildId":          in.buildID,
		"imageRef":         in.imageRef,
		"lbType":           in.loadBalancer.typ,
		"externalIp":       ip,
		"externalHostname": host,
		"ports":            ports,
		"domains":          domains,
		"detail":           detail,
	}
}

// renderK8sManifests builds Deployment + Service + (optional) Ingress
// YAML. Stays a string-builder rather than pulling client-go just for
// serialization — kaiad agent ships with kubectl, and YAML is the
// natural input format.
func renderK8sManifests(in redeployInput, namespace string) string {
	name := k8sName(in.serviceID)
	labelStr := fmt.Sprintf(
		"%s: %q\n        kaiad.dev/build-id: %q\n        kaiad.dev/environment: %q\n        app.kubernetes.io/name: %q\n        app.kubernetes.io/managed-by: kaiad",
		LabelServiceID, in.serviceID, in.buildID, in.environment, name,
	)

	// Deduplicate ports — multiple domains may share a port.
	portSet := map[int]bool{}
	var ports []int
	for _, d := range in.domains {
		if !portSet[d.port] {
			portSet[d.port] = true
			ports = append(ports, d.port)
		}
	}
	sort.Ints(ports)
	if len(ports) == 0 {
		ports = []int{80}
	}

	var b strings.Builder

	// ─── Deployment ───
	fmt.Fprintf(&b, "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: %s\n  namespace: %s\n  labels:\n        %s\nspec:\n  replicas: %d\n",
		name, namespace, labelStr, in.instances)
	fmt.Fprintf(&b, "  selector:\n    matchLabels:\n      %s: %q\n      kaiad.dev/environment: %q\n",
		LabelServiceID, in.serviceID, in.environment)
	fmt.Fprintf(&b, "  template:\n    metadata:\n      labels:\n        %s\n",
		labelStr,
	)
	b.WriteString("    spec:\n      containers:\n        - name: app\n")
	fmt.Fprintf(&b, "          image: %s\n", in.imageRef)
	if len(ports) > 0 {
		b.WriteString("          ports:\n")
		for _, p := range ports {
			fmt.Fprintf(&b, "            - containerPort: %d\n", p)
		}
	}
	b.WriteString("---\n")

	// ─── Service ───
	svcType := "ClusterIP"
	annotations := map[string]string{}
	switch in.loadBalancer.typ {
	case "k8s":
		svcType = "LoadBalancer"
		for k, v := range in.loadBalancer.annotations {
			annotations[k] = v
		}
	case "metallb":
		svcType = "LoadBalancer"
		if in.loadBalancer.addressPool != "" {
			annotations["metallb.universe.tf/address-pool"] = in.loadBalancer.addressPool
		}
	case "nginx", "none":
		// ClusterIP — for nginx, the Ingress fronts it; for none, only
		// in-cluster traffic reaches it.
	}

	fmt.Fprintf(&b, "apiVersion: v1\nkind: Service\nmetadata:\n  name: %s\n  namespace: %s\n", name, namespace)
	if len(annotations) > 0 {
		b.WriteString("  annotations:\n")
		for _, k := range sortedKeys(annotations) {
			fmt.Fprintf(&b, "    %s: %q\n", k, annotations[k])
		}
	}
	fmt.Fprintf(&b, "  labels:\n    %s: %q\n", LabelServiceID, in.serviceID)
	fmt.Fprintf(&b, "spec:\n  type: %s\n  selector:\n    %s: %q\n    kaiad.dev/environment: %q\n",
		svcType, LabelServiceID, in.serviceID, in.environment)
	b.WriteString("  ports:\n")
	for _, p := range ports {
		fmt.Fprintf(&b, "    - name: port-%d\n      port: %d\n      targetPort: %d\n      protocol: TCP\n", p, p, p)
	}
	b.WriteString("---\n")

	// ─── Ingress (nginx only) ───
	if in.loadBalancer.typ == "nginx" && len(in.domains) > 0 {
		ingressClass := in.loadBalancer.ingressClass
		if ingressClass == "" {
			ingressClass = "nginx"
		}
		fmt.Fprintf(&b, "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: %s\n  namespace: %s\n",
			name, namespace)
		fmt.Fprintf(&b, "  labels:\n    %s: %q\nspec:\n  ingressClassName: %s\n",
			LabelServiceID, in.serviceID, ingressClass)
		// Group domains that share TLS.
		if in.loadBalancer.tlsSecret != "" {
			b.WriteString("  tls:\n    - hosts:\n")
			for _, d := range in.domains {
				if d.protocol == "https" {
					fmt.Fprintf(&b, "        - %s\n", d.host)
				}
			}
			fmt.Fprintf(&b, "      secretName: %s\n", in.loadBalancer.tlsSecret)
		}
		b.WriteString("  rules:\n")
		for _, d := range in.domains {
			fmt.Fprintf(&b, "    - host: %s\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: %s\n                port:\n                  number: %d\n",
				d.host, name, d.port)
		}
		b.WriteString("---\n")
	}

	return b.String()
}

func k8sName(serviceID string) string {
	// kaiad-<short-uuid>. Lowercase; no underscores.
	return "kaiad-" + shortServiceName(serviceID)
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
