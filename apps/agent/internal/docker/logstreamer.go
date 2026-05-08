package docker

import (
	"bufio"
	"context"
	"strings"
)

type LogSender interface {
	SendLogEvent(agentID, serviceID, level, message string) error
}

// stripDockerLogHeader strips the 8-byte multiplexed stream header Docker
// prepends to each log frame when the container has no TTY (default).
// The header is: <stream-type:1><reserved:3><length:4 BE>.
//
// We don't know if a given line came from a TTY container or not, but the
// header's first byte is always 0x01 (stdout) or 0x02 (stderr); if we don't
// see one of those followed by 7 bytes that look header-shaped, we assume
// the line is plain text (TTY or already-stripped).
func stripDockerLogHeader(line string) string {
	if len(line) < 8 {
		return line
	}
	c0 := line[0]
	if c0 != 0x01 && c0 != 0x02 {
		return line
	}
	// bytes 1..3 are reserved (always zero); 4..7 are length BE.
	if line[1] != 0 || line[2] != 0 || line[3] != 0 {
		return line
	}
	return line[8:]
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
		line := stripDockerLogHeader(scanner.Text())
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
