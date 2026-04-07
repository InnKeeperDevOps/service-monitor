package main

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"github.com/service-monitor/agent/internal/credentials"
	"github.com/service-monitor/agent/internal/docker"
	"github.com/service-monitor/agent/internal/executor"
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
	envRealtimeURL := os.Getenv("SM_REALTIME_URL") != ""

	socketPath := os.Getenv("SM_DOCKER_SOCKET")
	dc := docker.NewClient(socketPath)
	exec := executor.NewExecutor(dc)

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
		if !envRealtimeURL && cred.RealtimeURL != "" {
			baseURL = cred.RealtimeURL
		}
	}
	if baseURL == "" {
		baseURL = "ws://localhost:3001/realtime"
	}
	if cred == nil && token == "" && isProduction() {
		log.Fatal("SM_ENROLLMENT_TOKEN (or saved credentials) is required in production")
	}

	log.Printf("starting agent id=%s ws=%s docker=%s", agentID, baseURL, dc.SocketPath())

	opts := []transport.ClientOption{
		transport.WithCommandHandler(exec),
	}
	if token != "" {
		opts = append(opts, transport.WithToken(token))
	}

	if cred == nil {
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

	client := transport.NewClient(baseURL, agentID, opts...)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var _ docker.LogSender = client

	if os.Getenv("SM_ENABLE_LOG_STREAMING") != "0" {
		streamExistingContainerLogs(ctx, dc, agentID, client)
	}

	if err := client.RunContext(ctx); err != nil {
		log.Fatalf("agent failed: %v", err)
	}
}
