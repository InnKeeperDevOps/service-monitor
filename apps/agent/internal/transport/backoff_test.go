package transport

import (
	"math/rand"
	"testing"
	"time"
)

func TestNextReconnectDelay_withinMinMax(t *testing.T) {
	t.Parallel()
	min := 10 * time.Millisecond
	max := 100 * time.Millisecond
	rng := rand.New(rand.NewSource(99))
	for attempt := 0; attempt < 12; attempt++ {
		for range 200 {
			d := nextReconnectDelay(attempt, min, max, rng)
			if d < min || d > max {
				t.Fatalf("attempt %d: delay %v not in [%v, %v]", attempt, d, min, max)
			}
		}
	}
}

func TestNextReconnectDelay_attemptZeroIsMinWhenNoSpan(t *testing.T) {
	t.Parallel()
	min := 5 * time.Millisecond
	max := time.Second
	rng := rand.New(rand.NewSource(1))
	d := nextReconnectDelay(0, min, max, rng)
	if d != min {
		t.Fatalf("expected %v, got %v", min, d)
	}
}

func TestNextReconnectDelay_maxBelowMinIsCoerced(t *testing.T) {
	t.Parallel()
	min := 50 * time.Millisecond
	max := 10 * time.Millisecond
	rng := rand.New(rand.NewSource(2))
	d := nextReconnectDelay(3, min, max, rng)
	if d < min || d > min {
		t.Fatalf("expected %v, got %v", min, d)
	}
}

func TestNextReconnectDelay_nilRNGStillBounded(t *testing.T) {
	t.Parallel()
	min := 20 * time.Millisecond
	max := 40 * time.Millisecond
	for range 80 {
		d := nextReconnectDelay(2, min, max, nil)
		if d < min || d > max {
			t.Fatalf("delay %v not in [%v, %v]", d, min, max)
		}
	}
}
