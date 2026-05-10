package main

import (
	"context"
	"log"
	"os"
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
// container. When `SM_SERVICE_ID` is set (e.g. baked into the start command by
// the admin UI when an enrollment token is generated) it pins every container
// on this agent to that tenant-scoped service. Otherwise it falls back to the
// container name (or short id) heuristic so dev hosts still get readable ids.
func serviceIDForContainer(c docker.ContainerInfo) string {
	if pinned := strings.TrimSpace(os.Getenv("SM_SERVICE_ID")); pinned != "" {
		return pinned
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

func streamExistingContainerLogs(ctx context.Context, dc *docker.Client, agentID string, sender docker.LogSender) {
	containers, err := dc.ListContainers(ctx)
	if err != nil {
		log.Printf("warning: listing containers for log stream failed: %v", err)
		return
	}
	for _, c := range containers {
		containerID := c.ID
		serviceID := serviceIDForContainer(c)
		go func() {
			if err := docker.StreamContainerLogs(ctx, dc, containerID, serviceID, agentID, sender); err != nil && ctx.Err() == nil {
				log.Printf("warning: log stream failed container=%s service=%s: %v", containerID, serviceID, err)
			}
		}()
	}
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
