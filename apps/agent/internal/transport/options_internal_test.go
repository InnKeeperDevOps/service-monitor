package transport

import (
	"context"
	"math/rand"
	"testing"
	"time"
)

type fakeHandler struct{}

func (fakeHandler) HandleCommand(_ context.Context, _ string, _ map[string]interface{}) (bool, string) {
	return true, "ok"
}

func TestNewClientWithAllOptions(t *testing.T) {
	c := NewClient(
		"wss://example/realtime", "agent-1",
		WithHeartbeatInterval(3*time.Second),
		WithReconnectBackoff(time.Second, 30*time.Second),
		WithRand(rand.New(rand.NewSource(1))),
		WithCommandHandler(fakeHandler{}),
		WithTenantID("t-1"),
		WithVersion("9.9.9"),
		WithToken("tok"),
		OnFirstAck(func() {}),
		OnHello(func(AgentHello) {}),
		WithProtocolDebugLog(func(string, ...interface{}) {}),
		WithHostStatsCollector(func(string) ([]byte, error) { return []byte("{}"), nil }),
		WithAppStatsCollector(func(string) ([][]byte, error) { return nil, nil }),
	)
	if c == nil {
		t.Fatal("NewClient returned nil")
	}
}
