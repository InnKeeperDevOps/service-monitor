package main

import (
	"context"
	"log"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"sync/atomic"

	"github.com/service-monitor/agent/internal/agentdebug"
	"github.com/service-monitor/agent/internal/appstats"
	"github.com/service-monitor/agent/internal/credentials"
	"github.com/service-monitor/agent/internal/docker"
	"github.com/service-monitor/agent/internal/executor"
	"github.com/service-monitor/agent/internal/hoststats"
	"github.com/service-monitor/agent/internal/logfile"
	"github.com/service-monitor/agent/internal/logship"
	"github.com/service-monitor/agent/internal/managed"
	"github.com/service-monitor/agent/internal/processstats"
	"github.com/service-monitor/agent/internal/processsup"
	"github.com/service-monitor/agent/internal/transport"
)

func isProduction() bool {
	return strings.EqualFold(os.Getenv("NODE_ENV"), "production")
}

// logShipBufferSize is the number of recent log lines kept per service for
// app_log_error context. Defaults to 50, override with SM_LOGSHIP_BUFFER.
func logShipBufferSize() int {
	if raw := os.Getenv("SM_LOGSHIP_BUFFER"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			return n
		}
	}
	return 50
}

// serviceIDForContainer chooses a service id for log frames emitted from a
// container. Resolution order:
//
//  1. `SM_SERVICE_ID` env override — pins EVERY container on this agent
//     to one tenant-scoped service id (used by single-service hosts).
//  2. The container's `kaiad.dev/service-name` label — the human-
//     readable name, set by redeploy.go on every kaiad-managed
//     container. Used as the cross-runtime dedup key: docker replicas
//     and k8s pods of the same MonitoredService share this string,
//     so the server's error-group fingerprint collapses both runtimes
//     into ONE entry per service.
//  3. K8s pod name prefix from `io.kubernetes.pod.name` — for pods
//     that weren't deployed by our agent (e.g. existing deployments
//     the user set up before binding the service to kaiad). The
//     deployment name typically matches the MonitoredService.name,
//     and the server falls back to a name-match on lookup.
//  4. The container's `kaiad.dev/service-id` label — fallback to the
//     UUID when neither name nor pod info is present.
//  5. Container name — for non-kaiad, non-k8s containers.
//  6. Short container id — last-resort fallback.
func serviceIDForContainer(c docker.ContainerInfo) string {
	if pinned := strings.TrimSpace(os.Getenv("SM_SERVICE_ID")); pinned != "" {
		return pinned
	}
	if name := strings.TrimSpace(c.Labels["kaiad.dev/service-name"]); name != "" {
		return name
	}
	if podName := strings.TrimSpace(c.Labels["io.kubernetes.pod.name"]); podName != "" {
		if deploymentName := extractK8sDeploymentName(podName); deploymentName != "" {
			return deploymentName
		}
	}
	if id := strings.TrimSpace(c.Labels["kaiad.dev/service-id"]); id != "" {
		return id
	}
	if len(c.Names) > 0 {
		name := strings.TrimPrefix(c.Names[0], "/")
		if name != "" {
			return name
		}
	}
	if c.ID != "" {
		if len(c.ID) > 12 {
			return c.ID[:12]
		}
		return c.ID
	}
	return "unknown-service"
}

// extractK8sDeploymentName turns a Pod name like
//
//	springboot-test-server-746b8b556d-qtrv8
//
// into the deployment name (`springboot-test-server`). Pods created by
// a Deployment → ReplicaSet are named `<deployment>-<rs-hash>-<pod-hash>`
// where each hash is 5–10 lowercase alphanumeric chars. Stripping the
// last two hyphen-segments that match that pattern recovers the
// deployment name. Returns "" if the shape doesn't match (StatefulSet
// pods, raw pods, naked Job pods, etc. — server fallback handles those).
func extractK8sDeploymentName(podName string) string {
	hashRe := regexp.MustCompile(`^[a-z0-9]{5,10}$`)
	parts := strings.Split(podName, "-")
	if len(parts) < 3 {
		return ""
	}
	// Confirm last two parts look like k8s-generated hashes.
	last := parts[len(parts)-1]
	prev := parts[len(parts)-2]
	if !hashRe.MatchString(last) || !hashRe.MatchString(prev) {
		return ""
	}
	return strings.Join(parts[:len(parts)-2], "-")
}

func streamExistingContainerLogs(ctx context.Context, dc *docker.Client, agentID string, sender docker.LogSender) {
	containers, err := dc.ListContainers(ctx)
	if err != nil {
		log.Printf("warning: listing containers for log stream failed: %v", err)
		return
	}
	// Discover our own container id so we don't tail our own stdout.
	// The agent's protocol-debug output contains the substring
	// "ERROR" (e.g. "outbound app_log_error"), and classifyLogLevel
	// would treat it as error-level and emit an app_log_error frame —
	// whose own outbound debug log line then contains "ERROR" — a
	// self-reinforcing loop. Skipping our own container kills it.
	selfID := readSelfContainerID()
	tailed := 0
	for _, c := range containers {
		if selfID != "" && c.ID == selfID {
			continue
		}
		// Only tail containers we consider part of a Kaiad-managed
		// service. Without this filter the agent would also tail
		// postgres/redis/registry/proxy/etc., flooding the platform's
		// in-memory error-group store with infrastructure noise and
		// OOM-ing the API. The acceptance criteria:
		//   • our own `kaiad.dev/service-id` label (deployed by the
		//     redeploy executor — covers docker mode)
		//   • Kubernetes pod metadata (covers k8s mode — the agent
		//     resolves the deployment name via `io.kubernetes.pod.name`)
		// Anything else is skipped; an operator who wants their own
		// container surface here can label it with kaiad.dev/service-id.
		if !isManagedContainer(c) {
			continue
		}
		containerID := c.ID
		serviceID := serviceIDForContainer(c)
		tailed++
		go func() {
			if err := docker.StreamContainerLogs(ctx, dc, containerID, serviceID, agentID, sender); err != nil && ctx.Err() == nil {
				log.Printf("warning: log stream failed container=%s service=%s: %v", containerID, serviceID, err)
			}
		}()
	}
	log.Printf("logship: attached to %d kaiad-managed container(s) of %d total", tailed, len(containers))
}

func isManagedContainer(c docker.ContainerInfo) bool {
	if c.Labels["kaiad.dev/component"] == "load-balancer" {
		return false // skip the LB itself — we already noise-filter it
	}
	if c.Labels["kaiad.dev/service-id"] != "" {
		return true
	}
	if c.Labels["kaiad.dev/service-name"] != "" {
		return true
	}
	if c.Labels["io.kubernetes.pod.name"] != "" {
		// K8s pods. Skip "infra" namespaces (kube-system etc.) so the
		// agent doesn't tail kube-proxy / coredns / storage-provisioner.
		ns := c.Labels["io.kubernetes.pod.namespace"]
		if ns == "kube-system" || ns == "kube-public" || ns == "kube-node-lease" {
			return false
		}
		// Also skip k8s pause sandbox containers ("k8s_POD_...").
		for _, n := range c.Names {
			if strings.HasPrefix(n, "/k8s_POD_") {
				return false
			}
		}
		return true
	}
	return false
}

// readSelfContainerID returns this process's docker container id by
// reading /proc/self/cgroup. Used to skip self-log-tailing. Returns ""
// when not running inside a docker container (host process, podman,
// etc.) — in which case there's nothing to skip.
func readSelfContainerID() string {
	b, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		// cgroup v1: "...:/docker/<id>"; v2: "...:/system.slice/docker-<id>.scope"
		if idx := strings.LastIndex(line, "/docker/"); idx >= 0 {
			id := line[idx+len("/docker/"):]
			if i := strings.IndexAny(id, ":."); i >= 0 {
				id = id[:i]
			}
			if len(id) >= 12 {
				return id
			}
		}
		if idx := strings.LastIndex(line, "/docker-"); idx >= 0 {
			id := line[idx+len("/docker-"):]
			if i := strings.IndexAny(id, ":."); i >= 0 {
				id = id[:i]
			}
			if len(id) >= 12 {
				return id
			}
		}
	}
	return ""
}

func main() {
	baseURL := os.Getenv("SM_REALTIME_URL")

	agentID := os.Getenv("SM_AGENT_ID")
	envAgentID := os.Getenv("SM_AGENT_ID") != ""
	token := os.Getenv("SM_ENROLLMENT_TOKEN")
	envToken := os.Getenv("SM_ENROLLMENT_TOKEN") != ""

	cred, err := credentials.Load()
	if err != nil {
		log.Fatalf("loading credentials: %v", err)
	}
	if cred != nil {
		log.Printf("loaded saved credential agent=%s", cred.AgentID)
		if !envAgentID {
			agentID = cred.AgentID
		}
		if !envToken {
			token = cred.Token
		}
		if os.Getenv("SM_REALTIME_URL") == "" && cred.RealtimeURL != "" {
			baseURL = cred.RealtimeURL
		}
	}
	if baseURL == "" {
		baseURL = "ws://localhost:3001/realtime"
	}
	if cred == nil && token == "" && isProduction() {
		log.Fatal("SM_ENROLLMENT_TOKEN (or saved credentials) is required in production")
	}

	socketPath := os.Getenv("SM_DOCKER_SOCKET")
	dc := docker.NewClient(socketPath)
	inventory := managed.New()
	exec := executor.NewExecutor(dc)
	exec.SetInventory(inventory)
	var backendAtomic atomic.Value
	backendAtomic.Store("docker")
	getBackend := func() string {
		v, _ := backendAtomic.Load().(string)
		return v
	}

	pinnedServiceID := strings.TrimSpace(os.Getenv("SM_SERVICE_ID"))
	if pinnedServiceID != "" {
		log.Printf("starting agent id=%s ws=%s service=%s (docker socket=%s; runtime from Kaiad hello)", agentID, baseURL, pinnedServiceID, dc.SocketPath())
	} else {
		log.Printf("starting agent id=%s ws=%s (docker socket=%s; runtime from Kaiad hello)", agentID, baseURL, dc.SocketPath())
	}
	if agentdebug.Enabled() {
		log.Printf("[agent:debug] SM_SKIP_KAIAD_CONFIG_WAIT=%q SM_ENABLE_LOG_STREAMING=%q SM_AGENT_PERSIST_CREDENTIALS=%q NODE_ENV=%q",
			os.Getenv("SM_SKIP_KAIAD_CONFIG_WAIT"), os.Getenv("SM_ENABLE_LOG_STREAMING"), os.Getenv("SM_AGENT_PERSIST_CREDENTIALS"), os.Getenv("NODE_ENV"))
	}

	var logStreamOnce sync.Once
	var client *transport.Client

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	opts := []transport.ClientOption{
		transport.WithCommandHandler(exec),
		transport.OnHello(func(h transport.AgentHello) {
			b := strings.ToLower(strings.TrimSpace(h.Runtime.Backend))
			if b == "" {
				b = "docker"
			}
			// Local override for hosts without a kaiad UI to set runtime
			// (tenant settings don't carry agentRuntimeBackend yet). Useful
			// for shell-runtime smoke tests on a docker-default panel.
			if override := strings.ToLower(strings.TrimSpace(os.Getenv("SM_AGENT_RUNTIME_OVERRIDE"))); override != "" {
				b = override
			}
			backendAtomic.Store(b)
			switch b {
			case "shell":
				exec.Configure(nil, executor.RuntimeShell)
			case "kubernetes":
				exec.Configure(nil, executor.RuntimeKubernetes)
			default:
				exec.Configure(dc, executor.RuntimeDocker)
			}
			// Echo the resolved backend back to the platform so the UI
			// can show docker-vs-k8s without inferring it. The hello
			// frame from Kaiad is hardcoded to "docker" today; the
			// agent's own override (SM_AGENT_RUNTIME_OVERRIDE) plus the
			// switch above is the only authoritative source.
			if client != nil {
				client.SetRuntime(b)
			}
			log.Printf("kaiad hello: agent runtime backend=%s", b)

			logStreamOnce.Do(func() {
				if os.Getenv("SM_ENABLE_LOG_STREAMING") == "0" {
					return
				}
				if client == nil {
					return
				}
				// Wrap the transport client with a buffering log-shipper so that
				// every error-level line is also emitted as an app_log_error
				// frame carrying the last 50 context lines for the same service.
				bufferSize := logShipBufferSize()
				logSender := logship.NewSender(client, client, bufferSize)

				if b == "docker" {
					streamExistingContainerLogs(ctx, dc, agentID, logSender)
					return
				}
				if b == "kubernetes" {
					// k8s-mode agents observe pods via the docker daemon
					// running on the kubelet node — the agent's pod has
					// /var/run/docker.sock mounted from the host. Pods
					// surface as containers labelled with the k8s pod
					// metadata; serviceIDForContainer maps the
					// kaiad.dev/service-id label (set by our k8s
					// manifest renderer) to the same UUID the docker-
					// mode agents use, so incidents from both runtimes
					// dedupe into one error-group entry per service.
					streamExistingContainerLogs(ctx, dc, agentID, logSender)
					return
				}
				if b == "shell" {
					// For shell-runtime, log streaming happens via file tailing
					// driven by sync_desired_state. The supervisor (re)starts
					// processes and registers their log files with the tailer.
					tailer := logfile.New(logSender)
					sup := processsup.New(tailer, agentID)
					exec.SetProcessReconciler(sup)
					log.Printf("shell-runtime supervisor + tailer wired (agent=%s)", agentID)
				}
			})
		}),
	}
	if token != "" {
		opts = append(opts, transport.WithToken(token))
	}

	if cred == nil && credentials.PersistenceEnabled() && token != "" {
		opts = append(opts, transport.OnFirstAck(func() {
			c := credentials.Credential{
				AgentID:     agentID,
				Token:       token,
				EnrolledAt:  time.Now().UTC(),
				RealtimeURL: baseURL,
			}
			if err := credentials.Save(c); err != nil {
				log.Printf("warning: failed to save credential: %v", err)
				return
			}
			log.Printf("credential saved for agent=%s", agentID)
		}))
	}

	if runtime.GOOS == "linux" && os.Getenv("SM_DISABLE_HOST_STATS") != "1" {
		hs := hoststats.NewSampler()
		opts = append(opts, transport.WithHostStatsCollector(hs.Build))
	}
	if os.Getenv("SM_DISABLE_APP_STATS") != "1" {
		as := appstats.NewSampler(dc, appstats.Options{
			GetBackend: getBackend,
			Inventory:  inventory,
		})
		ps := processstats.NewSampler(inventory)
		combined := func(agentID string) ([][]byte, error) {
			frames, err := as.Build(agentID)
			if err != nil {
				return nil, err
			}
			procFrames, _ := ps.Build(agentID)
			if len(procFrames) > 0 {
				frames = append(frames, procFrames...)
			}
			return frames, nil
		}
		opts = append(opts, transport.WithAppStatsCollector(combined))
	}

	client = transport.NewClient(baseURL, agentID, opts...)

	var _ docker.LogSender = client

	// Wire the reporter callback so command handlers (notably
	// redeploy_service in k8s mode) can push lb_status_report messages
	// over the same websocket the client owns.
	exec.SetPlatformReporter(client.SendPlatformMessage)
	exec.SetAgentID(agentID)

	if err := client.RunContext(ctx); err != nil {
		log.Fatalf("agent failed: %v", err)
	}
}
