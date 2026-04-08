package main

import (
	"context"
	"log"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/agentdebug"
	"github.com/service-monitor/agent/internal/credentials"
	"github.com/service-monitor/agent/internal/docker"
	"github.com/service-monitor/agent/internal/executor"
	"github.com/service-monitor/agent/internal/hoststats"
	"github.com/service-monitor/agent/internal/transport"
)

func isProduction() bool {
	return strings.EqualFold(os.Getenv("NODE_ENV"), "production")
}

func serviceIDForContainer(c docker.ContainerInfo) string {
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
	exec := executor.NewExecutor(dc)

	log.Printf("starting agent id=%s ws=%s (docker socket=%s; runtime from Kaiad hello)", agentID, baseURL, dc.SocketPath())
	if agentdebug.Enabled() {
		log.Printf("[agent:debug] SM_SKIP_KAIAD_CONFIG_WAIT=%q SM_ENABLE_LOG_STREAMING=%q SM_AGENT_PERSIST_CREDENTIALS=%q NODE_ENV=%q",
			os.Getenv("SM_SKIP_KAIAD_CONFIG_WAIT"), os.Getenv("SM_ENABLE_LOG_STREAMING"), os.Getenv("SM_AGENT_PERSIST_CREDENTIALS"), os.Getenv("NODE_ENV"))
	}

	var logStreamOnce sync.Once
	var client *transport.Client
	var configWaitMu sync.Mutex
	var configWaitTimer *time.Timer

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	opts := []transport.ClientOption{
		transport.WithCommandHandler(exec),
		transport.OnHello(func(h transport.AgentHello) {
			skipWait := os.Getenv("SM_SKIP_KAIAD_CONFIG_WAIT") == "1"
			ready, wsrc := h.ResolveKaiadConfig(skipWait)

			configWaitMu.Lock()
			if configWaitTimer != nil {
				configWaitTimer.Stop()
				configWaitTimer = nil
			}
			configWaitMu.Unlock()

			b := strings.ToLower(strings.TrimSpace(h.Runtime.Backend))
			if b == "" {
				b = "docker"
			}
			switch b {
			case "shell":
				exec.Configure(nil, executor.RuntimeShell, ready, wsrc)
			case "kubernetes":
				exec.Configure(nil, executor.RuntimeKubernetes, ready, wsrc)
			default:
				exec.Configure(dc, executor.RuntimeDocker, ready, wsrc)
			}
			log.Printf("kaiad hello: agent runtime backend=%s workload=%s configReady=%v", b, wsrc, ready)
			if !ready {
				log.Printf("kaiad: waiting for tenant agent configuration — set Workload source in Kaiad Settings; will reconnect periodically to pick up changes")
				configWaitMu.Lock()
				configWaitTimer = time.AfterFunc(20*time.Second, func() {
					if client != nil {
						log.Printf("kaiad: reconnecting to refresh agent configuration")
						client.CloseActiveForReconnect()
					}
				})
				configWaitMu.Unlock()
			}
			logStreamOnce.Do(func() {
				if b != "docker" {
					return
				}
				if os.Getenv("SM_ENABLE_LOG_STREAMING") == "0" {
					return
				}
				if client == nil {
					return
				}
				streamExistingContainerLogs(ctx, dc, agentID, client)
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

	client = transport.NewClient(baseURL, agentID, opts...)

	var _ docker.LogSender = client

	if err := client.RunContext(ctx); err != nil {
		log.Fatalf("agent failed: %v", err)
	}
}
