package transport

import (
	"math/rand"
	"time"
)

// nextReconnectDelay returns exponential backoff capped at max, with uniform jitter in [min, exp].
// attempt 0 yields exp=min; higher attempts double exp until max. Result is always in [min, max].
func nextReconnectDelay(attempt int, min, max time.Duration, rng *rand.Rand) time.Duration {
	if min <= 0 {
		min = time.Second
	}
	if max < min {
		max = min
	}
	exp := min
	for i := 0; i < attempt && exp < max; i++ {
		next := exp * 2
		if next > max {
			exp = max
			break
		}
		exp = next
	}
	if exp > max {
		exp = max
	}
	span := exp - min
	if span <= 0 {
		return min
	}
	if rng == nil {
		rng = rand.New(rand.NewSource(time.Now().UnixNano()))
	}
	return min + time.Duration(rng.Int63n(int64(span)+1))
}
