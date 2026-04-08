package hoststats

import (
	"os"
	"sync"
	"time"
)

// Sampler collects host metrics between periodic samples (CPU and network need a prior reading).
type Sampler struct {
	mu sync.Mutex

	diskPath string

	lastAt       time.Time
	lastCPUIdle  uint64
	lastCPUTotal uint64
	lastNetRx    uint64
	lastNetTx    uint64
}

// NewSampler returns a sampler using SM_AGENT_STATS_DISK_PATH or "/" for disk usage.
func NewSampler() *Sampler {
	p := os.Getenv("SM_AGENT_STATS_DISK_PATH")
	if p == "" {
		p = "/"
	}
	return &Sampler{diskPath: p}
}
