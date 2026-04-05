package docker

import (
	"bufio"
	"context"
	"strings"
)

type LogSender interface {
	SendLogEvent(agentID, serviceID, level, message string) error
}

func StreamContainerLogs(ctx context.Context, client *Client, containerID, serviceID, agentID string, sender LogSender) error {
	stream, err := client.StreamLogs(ctx, containerID, "0")
	if err != nil {
		return err
	}
	defer stream.Close()

	scanner := bufio.NewScanner(stream)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line := scanner.Text()
		if len(line) == 0 {
			continue
		}
		level := classifyLogLevel(line)
		if err := sender.SendLogEvent(agentID, serviceID, level, line); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func classifyLogLevel(line string) string {
	upper := strings.ToUpper(line)
	for _, kw := range []string{"ERROR", "FATAL", "EXCEPTION", "TRACEBACK"} {
		if strings.Contains(upper, kw) {
			return "error"
		}
	}
	return "info"
}
