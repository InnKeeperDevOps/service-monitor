// Package lb runs a per-agent nginx load balancer for docker-runtime
// agents. The platform side dispatches redeploy_service with the
// container set + the domains that should reach them; this package
// renders a per-service nginx conf snippet, ships it into the
// kaiad-managed nginx container, and reloads.
//
// Topology:
//
//   docker bridge network "kaiad-lb-net"
//   ├── kaiad-lb        (nginx:alpine; published on host :80/:443)
//   └── kaiad-cc43...-0 (the actual service container)
//       kaiad-cc43...-1
//
// Both the LB and the service containers share the custom bridge, so
// docker's embedded DNS (127.0.0.11) resolves container names back to
// per-network IPs. nginx uses that for upstream targets — no IP
// pinning, no manual reload on replica restart (just upstream re-DNS).
//
// Config wire-up:
//   - The LB owns /etc/nginx/conf.d/. We never bind-mount it from the
//     host — we PUT a tar into the container's filesystem via the
//     docker REST API, which keeps the agent free of bind-mount
//     orchestration on its own side.
//   - One file per service: kaiad-<serviceID-short>.conf. Removing the
//     file + reloading nginx is the teardown path.
//   - A default `default.conf` (empty server returning 404) is shipped
//     on Ensure so requests with no matching server_name get a clean
//     error instead of accidentally hitting whatever upstream nginx
//     defaulted to.
package lb

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/docker"
)

// ensureMu serializes Ensure across goroutines. The agent's transport
// layer dispatches each command in its own goroutine, so multiple
// concurrent redeploy_service calls each call Manager.Ensure — racing
// on `docker create kaiad-lb` and producing 409 Conflict errors. A
// package-level mutex is fine here because the LB is a per-host
// singleton; serializing Ensure costs nothing once it's up.
var ensureMu sync.Mutex

// Domain mirrors the per-domain shape from the platform's
// redeploy_service payload — only the fields nginx routing needs.
type Domain struct {
	Host     string
	Port     int    // upstream container port to proxy to
	Protocol string // "http" | "https" — v1 terminates HTTP only; https is treated as http
}

// Manager owns the singleton kaiad-lb container + the shared docker
// network. Safe to construct on every redeploy: Ensure is idempotent
// and bails out fast when everything is already in place.
type Manager struct {
	dc       *docker.Client
	netName  string
	lbName   string
	image    string
	httpPort int
	// labels set on the LB container so the agent can find it back
	// across restarts and so an operator can grep `docker ps` for
	// kaiad-managed infrastructure containers.
	labels map[string]string
}

// DefaultManager wires up a Manager with the standard names + env
// overrides. The image defaults to nginx:alpine (small, ubiquitous,
// has /etc/nginx/conf.d/ baked in). Override via KAIAD_LB_IMAGE if a
// hardened/pinned image is required.
func DefaultManager(dc *docker.Client) *Manager {
	image := strings.TrimSpace(os.Getenv("KAIAD_LB_IMAGE"))
	if image == "" {
		image = "nginx:alpine"
	}
	httpPort := 80
	if p := strings.TrimSpace(os.Getenv("KAIAD_LB_HTTP_PORT")); p != "" {
		var v int
		fmt.Sscanf(p, "%d", &v)
		if v > 0 && v < 65536 {
			httpPort = v
		}
	}
	return &Manager{
		dc:       dc,
		netName:  envOr("KAIAD_LB_NETWORK", "kaiad-lb-net"),
		lbName:   envOr("KAIAD_LB_CONTAINER", "kaiad-lb"),
		image:    image,
		httpPort: httpPort,
		labels: map[string]string{
			"kaiad.dev/managed-by": "kaiad-agent",
			"kaiad.dev/component":  "load-balancer",
		},
	}
}

func envOr(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}

// NetworkName is the docker bridge network service containers must be
// attached to so the LB's nginx can reach them by name.
func (m *Manager) NetworkName() string { return m.netName }

// Ensure makes sure the network exists, the LB container is running,
// and the baseline default-server config is in place. Idempotent —
// the only side effects on a steady-state agent are quick HEAD-style
// docker API calls.
func (m *Manager) Ensure(ctx context.Context) error {
	if m.dc == nil {
		return fmt.Errorf("lb.Ensure: docker client unavailable")
	}
	// Serialize across concurrent redeploys — the transport layer runs
	// commands in their own goroutines, so without this lock we get
	// `409 Conflict` storms whenever two redeploys land in the same tick.
	ensureMu.Lock()
	defer ensureMu.Unlock()

	// 1) Network.
	if _, err := m.dc.EnsureNetwork(ctx, m.netName); err != nil {
		return fmt.Errorf("ensure network: %w", err)
	}

	// 2) LB container: if it already exists and is running, we're done.
	// If it exists but isn't running, recreate (cheaper than figuring
	// out start state). If it doesn't exist, pull image + create.
	if id, _ := m.dc.FindContainerByName(ctx, m.lbName); id != "" {
		// Sanity-check by execing into it. If `nginx -v` works, the LB
		// is live; otherwise fall through to recreate.
		if _, err := m.dc.ExecRun(ctx, id, []string{"nginx", "-v"}); err == nil {
			return m.writeDefaultConfIfMissing(ctx, id)
		}
		// Stale or dead — remove and recreate.
		_ = m.dc.RemoveContainer(ctx, id)
	}

	// Pull. nginx:alpine pulls fast and lives in the public registry —
	// no auth header needed. Caller can override via KAIAD_LB_IMAGE.
	if err := m.dc.PullImage(ctx, m.image, nil); err != nil {
		return fmt.Errorf("pull lb image %s: %w", m.image, err)
	}

	id, err := m.dc.CreateContainer(ctx, docker.CreateContainerOpts{
		Name:    m.lbName,
		Image:   m.image,
		Labels:  m.labels,
		Network: m.netName,
		Restart: "unless-stopped",
		Ports: []docker.PortBinding{
			{ContainerPort: 80, HostPort: m.httpPort, Protocol: "tcp"},
		},
	})
	if err != nil {
		// Defence in depth: even with the mutex, an LB created by a
		// previous agent process (before we restarted) could already
		// hold the name. Treat 409 as "another caller already provided
		// the LB" and continue using it.
		if strings.Contains(err.Error(), "status 409") {
			if eid, _ := m.dc.FindContainerByName(ctx, m.lbName); eid != "" {
				return m.writeDefaultConfIfMissing(ctx, eid)
			}
		}
		return fmt.Errorf("create lb container: %w", err)
	}
	if err := m.dc.StartContainer(ctx, id); err != nil {
		return fmt.Errorf("start lb container: %w", err)
	}
	// Wait briefly for nginx to come up so the very first
	// AttachService doesn't race the LB's bootstrap. nginx:alpine
	// usually serves within ~300 ms; cap at 5 s.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := m.dc.ExecRun(ctx, id, []string{"nginx", "-v"}); err == nil {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	return m.writeDefaultConfIfMissing(ctx, id)
}

// writeDefaultConfIfMissing replaces the nginx image's default.conf
// with a 444-return catch-all. Without this, a request whose Host
// matches no server block falls into nginx's "default_server"
// behaviour and hits the literal nginx welcome page — confusing
// during incidents. Idempotent: writes every Ensure.
//
// The reload at the end is best-effort: when this is called while
// another service redeploy is mid-flight (its old containers have
// been removed but new ones haven't been wired up yet), nginx's
// reload parse will fail on that stale conf's upstreams. We don't
// want Ensure to fail in that case — the next AttachService call
// will rewrite the conflicting conf and reload again successfully.
func (m *Manager) writeDefaultConfIfMissing(ctx context.Context, ctrID string) error {
	const def = `# Managed by kaiad — do not edit.
# Catch-all so requests for unknown Host headers return a clean 444
# (connection close) instead of nginx's default welcome page.
server {
    listen 80 default_server;
    server_name _;
    return 444;
}
`
	tarBytes, err := buildSingleFileTar("default.conf", []byte(def))
	if err != nil {
		return err
	}
	if err := m.dc.PutArchive(ctx, ctrID, "/etc/nginx/conf.d", tarBytes); err != nil {
		return fmt.Errorf("upload default.conf: %w", err)
	}
	if out, err := m.dc.ExecRun(ctx, ctrID, []string{"nginx", "-s", "reload"}); err != nil {
		log.Printf("[lb] nginx reload during Ensure returned: %v\noutput: %s", err, out)
	}
	return nil
}

// AttachService writes (or rewrites) the conf snippet for one service
// and reloads nginx.
//
//	serviceName  — the kaiad service name. When non-empty the upstream
//	               is dialed by this docker-DNS alias (every replica
//	               shares it via `--network-alias`), which lets nginx
//	               resolve at request time instead of parse time. That
//	               in turn means one service's broken upstream can't
//	               block the LB from serving every other service.
//	upstreams    — concrete container names. Used only when serviceName
//	               is empty (legacy/pre-alias redeploys), and combined
//	               with a runtime resolver to stay parse-time-resilient.
//	port         — upstream port inside the container.
//	domains      — kaiad.yaml domain list (Host: server_name).
//
// Empty `domains` is a no-op: nothing to route, but we still wipe any
// stale snippet from a previous deploy that had domains.
func (m *Manager) AttachService(
	ctx context.Context,
	serviceID, serviceName, namespace string,
	upstreams []string,
	port int,
	domains []Domain,
) error {
	if m.dc == nil {
		return fmt.Errorf("lb.AttachService: docker client unavailable")
	}
	ctrID, err := m.dc.FindContainerByName(ctx, m.lbName)
	if err != nil {
		return fmt.Errorf("find lb container: %w", err)
	}
	if ctrID == "" {
		return fmt.Errorf("lb container %q not found — call Ensure first", m.lbName)
	}

	confName := snippetName(serviceID, namespace)
	// Nothing to route. Make sure no stale conf remains, then reload so
	// the catch-all behaviour is fully restored. We allow serviceName-
	// only routing (no concrete replica list yet) since the alias path
	// still resolves at request time once a replica comes up.
	hasTarget := serviceName != "" || len(upstreams) > 0
	if len(domains) == 0 || !hasTarget || port == 0 {
		return m.DetachService(ctx, serviceID, namespace)
	}

	conf := renderServiceConf(serviceID, serviceName, namespace, upstreams, port, domains)
	tarBytes, err := buildSingleFileTar(confName, []byte(conf))
	if err != nil {
		return err
	}
	if err := m.dc.PutArchive(ctx, ctrID, "/etc/nginx/conf.d", tarBytes); err != nil {
		return fmt.Errorf("upload %s: %w", confName, err)
	}
	// We deliberately do NOT block on `nginx -t` here. OSS nginx
	// resolves upstream `server` directives at config-load time; if
	// a replica is in a Restarting state at the exact moment we
	// reload, docker DNS briefly fails for that name and -t returns
	// "host not found in upstream" — even when the conf will be fine
	// in seconds. Treating that as fatal would block every redeploy
	// that runs alongside a flaky service.
	//
	// nginx's reload is itself transactional: if the new config can't
	// be parsed at reload, the old workers keep serving and the
	// reload is a quiet no-op. So we just send the signal and log
	// any error for diagnosis.
	if out, err := m.dc.ExecRun(ctx, ctrID, []string{"nginx", "-s", "reload"}); err != nil {
		log.Printf("[lb] nginx reload after writing %s returned: %v\noutput: %s", confName, err, out)
	}
	// Best-effort syntax check after the fact — strictly informational.
	if out, err := m.dc.ExecRun(ctx, ctrID, []string{"nginx", "-t"}); err != nil {
		log.Printf("[lb] nginx -t (post-write, informational) for %s: %v\noutput: %s", confName, err, out)
	}
	return nil
}

// DetachService removes any snippet this agent wrote for the service
// and reloads. Silent no-op if the snippet doesn't exist; that's the
// typical case during a teardown of a service that never had domains.
func (m *Manager) DetachService(ctx context.Context, serviceID, namespace string) error {
	if m.dc == nil {
		return nil
	}
	ctrID, err := m.dc.FindContainerByName(ctx, m.lbName)
	if err != nil || ctrID == "" {
		// LB isn't around — nothing to detach from. Don't fail the
		// teardown over this; the cluster-side state is already gone.
		return nil
	}
	confName := snippetName(serviceID, namespace)
	// rm -f exits 0 when the file doesn't exist, so this stays
	// idempotent across repeat teardowns.
	if _, err := m.dc.ExecRun(ctx, ctrID, []string{"rm", "-f", "/etc/nginx/conf.d/" + confName}); err != nil {
		return fmt.Errorf("rm conf: %w", err)
	}
	if _, err := m.dc.ExecRun(ctx, ctrID, []string{"nginx", "-s", "reload"}); err != nil {
		return fmt.Errorf("nginx reload: %w", err)
	}
	return nil
}

// snippetName returns the conf filename for a (serviceID, namespace)
// pair. Hashed so a long uuid + namespace stay within nginx's filename
// expectations and one service can have at most one conf in the LB
// (matches the platform's `(service_id, environment)` unique key).
func snippetName(serviceID, namespace string) string {
	h := sha1.Sum([]byte(namespace + "/" + serviceID))
	return "kaiad-" + hex.EncodeToString(h[:8]) + ".conf"
}

// renderServiceConf produces a single `server { ... }` block per
// service. CRUCIALLY: no `upstream { ... }` block — we use a variable
// in `proxy_pass` instead.
//
// Why this matters: nginx OSS resolves `upstream { server <name>; }`
// entries at config-LOAD time. If even one upstream's DNS doesn't
// resolve (replica restarting, container removed mid-redeploy, etc.),
// nginx refuses to parse the entire config — taking down the LB and
// every other service it routes. Using `set $up "<host>:<port>"`
// followed by `proxy_pass http://$up` defers DNS to request time,
// where docker's embedded resolver (127.0.0.11 on custom networks)
// handles round-robin across replicas sharing the same alias and
// returns NXDOMAIN gracefully (502 for this service only, rest of
// the LB unaffected).
//
// Target host preference order:
//  1. `serviceName` — the docker network alias every replica shares
//     (set by redeploy.go via --network-alias). Round-robins among
//     replicas via docker DNS, no nginx-side upstream pool needed.
//  2. First concrete container name — fallback for pre-alias agents
//     or single-replica services without a serviceName label.
func renderServiceConf(serviceID, serviceName, namespace string, upstreams []string, port int, domains []Domain) string {
	target := strings.TrimSpace(serviceName)
	if target == "" && len(upstreams) > 0 {
		// Sort so the same set always renders identically (keeps
		// reload-on-redeploy churn clean) and pick the first.
		sortedUp := append([]string(nil), upstreams...)
		sort.Strings(sortedUp)
		target = sortedUp[0]
	}

	sortedDomains := append([]Domain(nil), domains...)
	sort.Slice(sortedDomains, func(i, j int) bool { return sortedDomains[i].Host < sortedDomains[j].Host })

	var b strings.Builder
	fmt.Fprintf(&b, "# Managed by kaiad — service=%s name=%s namespace=%s\n", serviceID, serviceName, namespace)
	fmt.Fprintf(&b, "# Edits will be overwritten on the next redeploy_service.\n\n")

	names := uniqueHosts(sortedDomains)
	fmt.Fprintf(&b, "server {\n")
	fmt.Fprintf(&b, "    listen 80;\n")
	fmt.Fprintf(&b, "    server_name %s;\n", strings.Join(names, " "))
	// Docker's embedded DNS at 127.0.0.11. `valid=10s` is short enough
	// that a replaced container is picked up quickly; `ipv6=off`
	// avoids the brief delay when docker doesn't have an AAAA record.
	fmt.Fprintf(&b, "    resolver 127.0.0.11 valid=10s ipv6=off;\n")
	fmt.Fprintf(&b, "    location / {\n")
	// Variable assignment forces nginx to resolve the target at
	// REQUEST time, not load time — that's what makes the LB resilient
	// to one service's upstream being temporarily unresolvable.
	fmt.Fprintf(&b, "        set $kaiad_upstream %q;\n", fmt.Sprintf("%s:%d", target, port))
	fmt.Fprintf(&b, "        proxy_pass http://$kaiad_upstream;\n")
	fmt.Fprintf(&b, "        proxy_set_header Host              $host;\n")
	fmt.Fprintf(&b, "        proxy_set_header X-Real-IP         $remote_addr;\n")
	fmt.Fprintf(&b, "        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;\n")
	fmt.Fprintf(&b, "        proxy_set_header X-Forwarded-Proto $scheme;\n")
	fmt.Fprintf(&b, "        proxy_read_timeout 60s;\n")
	fmt.Fprintf(&b, "    }\n")
	fmt.Fprintf(&b, "}\n")
	return b.String()
}

func uniqueHosts(domains []Domain) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(domains))
	for _, d := range domains {
		if seen[d.Host] {
			continue
		}
		seen[d.Host] = true
		out = append(out, d.Host)
	}
	return out
}

// buildSingleFileTar packs one file into a tar suitable for docker's
// PUT /containers/<id>/archive. Permissions are 0644 because nginx
// reads conf files as root; uid/gid stay 0/0 for the same reason.
func buildSingleFileTar(name string, body []byte) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	hdr := &tar.Header{
		Name: name,
		Mode: 0644,
		Size: int64(len(body)),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return nil, fmt.Errorf("tar header: %w", err)
	}
	if _, err := tw.Write(body); err != nil {
		return nil, fmt.Errorf("tar write: %w", err)
	}
	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("tar close: %w", err)
	}
	return buf.Bytes(), nil
}
