// Command mock-realtime-server is a minimal Kaiad /realtime WebSocket mock for validating the Go agent transport against the same JSON shapes as apps/api (hello + ack per frame).
//
// Usage:
//
//	go run ./cmd/mock-realtime-server -listen :3001
//	SM_REALTIME_URL=ws://127.0.0.1:3001/realtime SM_AGENT_ID=test go run ./cmd/agent
//
// With enrollment token query param (agent sets ?token=...):
//
//	go run ./cmd/mock-realtime-server -listen :3001 -token devtoken
//	SM_ENROLLMENT_TOKEN=devtoken SM_REALTIME_URL=ws://127.0.0.1:3001/realtime ...
//
// Inject receive_source_archive (path must exist on the agent host when the agent runs):
//
//	go run ./cmd/mock-realtime-server -listen :3001 -inject-receive-archive /path/on/agent/app.tar.gz -inject-receive-dest /tmp/ws
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/service-monitor/agent/internal/mockrealtime"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:3001", "listen address (host:port)")
	path := flag.String("path", "/realtime", "WebSocket path")
	token := flag.String("token", "", "if set, require matching ?token= on the WebSocket URL")
	runtimeBackend := flag.String("runtime", "docker", "hello runtime.backend (docker|kubernetes|shell)")
	injectPath := flag.String("inject", "", "optional path to JSON file: sent as one text frame after the first heartbeat (e.g. run_step command)")
	injectReceiveArchive := flag.String("inject-receive-archive", "", "if set, path to a .tar.gz on the agent host: inject receive_source_archive after first heartbeat (overrides -inject file when set)")
	injectReceiveDest := flag.String("inject-receive-dest", "", "optional destDir for -inject-receive-archive")
	flag.Parse()

	h := mockrealtime.DefaultHello()
	h.RuntimeBackend = *runtimeBackend

	var inject []byte
	if strings.TrimSpace(*injectReceiveArchive) != "" {
		inject = mockrealtime.MustJSON(mockrealtime.ReceiveSourceArchiveCommand(
			strings.TrimSpace(*injectReceiveArchive),
			strings.TrimSpace(*injectReceiveDest),
			"",
		))
	} else if *injectPath != "" {
		b, err := os.ReadFile(*injectPath)
		if err != nil {
			log.Fatalf("read -inject file: %v", err)
		}
		inject = json.RawMessage(b)
	}

	srv := mockrealtime.NewServer(mockrealtime.Config{
		Path:                      *path,
		RequireToken:              *token,
		Hello:                     h,
		InjectAfterFirstHeartbeat: inject,
	})

	mux := http.NewServeMux()
	mux.Handle(*path, srv)

	log.Printf(
		"mock realtime listening on http://%s%s (token=%q inject-file=%v inject-receive-archive=%q)",
		*listen, *path, *token, *injectPath != "", strings.TrimSpace(*injectReceiveArchive),
	)
	log.Fatal(http.ListenAndServe(*listen, mux))
}
