//go:build !linux

package hoststats

// Build is a no-op on non-Linux platforms; the agent does not send host_stats.
func (s *Sampler) Build(agentID string) ([]byte, error) {
	_ = agentID
	_ = s
	return nil, nil
}
