//go:build linux

package hoststats

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Build returns a JSON host_stats frame for Kaiad, or (nil, nil) when nothing should be sent.
func (s *Sampler) Build(agentID string) ([]byte, error) {
	now := time.Now()
	ts := now.UTC().Format(time.RFC3339Nano)

	memUsed, memTotal, memOk := readMeminfo()
	diskUsed, diskTotal, diskOk := readDisk(s.diskPath)
	rss, rssOk := readProcSelfRSS()

	cpuIdle, cpuTotal, cpuOk := readCPUTimes()
	netRx, netTx, netOk := readNetDevAggregate()

	s.mu.Lock()
	prevAt := s.lastAt
	var cpuPercent *float64
	var netRxSec, netTxSec *float64

	if cpuOk && netOk && !prevAt.IsZero() {
		dt := now.Sub(prevAt).Seconds()
		if dt < 1e-3 {
			dt = 1e-3
		}
		dIdle := float64(cpuIdle) - float64(s.lastCPUIdle)
		dTot := float64(cpuTotal) - float64(s.lastCPUTotal)
		if dTot > 0 && dIdle >= 0 && dIdle <= dTot {
			v := (1.0 - dIdle/dTot) * 100.0
			if v < 0 {
				v = 0
			}
			if v > 100 {
				v = 100
			}
			cpuPercent = &v
		}
		dRx := float64(netRx) - float64(s.lastNetRx)
		dTx := float64(netTx) - float64(s.lastNetTx)
		if dRx >= 0 && dTx >= 0 {
			rx := dRx / dt
			tx := dTx / dt
			netRxSec = &rx
			netTxSec = &tx
		}
	}
	if cpuOk && netOk {
		s.lastCPUIdle, s.lastCPUTotal = cpuIdle, cpuTotal
		s.lastNetRx, s.lastNetTx = netRx, netTx
		s.lastAt = now
	}
	s.mu.Unlock()

	msg := map[string]interface{}{
		"type":    "host_stats",
		"agentId": agentID,
		"ts":      ts,
	}
	if cpuPercent != nil {
		msg["cpuPercent"] = *cpuPercent
	}
	if memOk {
		msg["memUsedBytes"] = memUsed
		msg["memTotalBytes"] = memTotal
		if memTotal > 0 {
			msg["memPercent"] = float64(memUsed) / float64(memTotal) * 100.0
		}
	}
	if diskOk {
		msg["diskUsedBytes"] = diskUsed
		msg["diskTotalBytes"] = diskTotal
		msg["diskPath"] = s.diskPath
	}
	if netRxSec != nil {
		msg["netRxBytesPerSec"] = *netRxSec
	}
	if netTxSec != nil {
		msg["netTxBytesPerSec"] = *netTxSec
	}
	if rssOk {
		msg["processRSSBytes"] = rss
	}

	if len(msg) <= 3 {
		return nil, nil
	}

	return json.Marshal(msg)
}

func readCPUTimes() (idle, total uint64, ok bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil || len(b) == 0 {
		return 0, 0, false
	}
	lines := strings.Split(string(b), "\n")
	if len(lines) == 0 {
		return 0, 0, false
	}
	fields := strings.Fields(lines[0])
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, false
	}
	var vals []uint64
	for _, f := range fields[1:] {
		v, err := strconv.ParseUint(f, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		vals = append(vals, v)
	}
	var sum uint64
	for _, v := range vals {
		sum += v
	}
	if len(vals) < 4 {
		return 0, 0, false
	}
	idleVal := vals[3]
	if len(vals) >= 5 {
		idleVal += vals[4] // iowait
	}
	return idleVal, sum, true
}

func readMeminfo() (used, total uint64, ok bool) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, false
	}
	var memTotal, memAvail, memFree uint64
	var haveTotal, haveAvail, haveFree bool
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if v, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
					memTotal = v * 1024
					haveTotal = true
				}
			}
		}
		if strings.HasPrefix(line, "MemAvailable:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if v, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
					memAvail = v * 1024
					haveAvail = true
				}
			}
		}
		if strings.HasPrefix(line, "MemFree:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if v, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
					memFree = v * 1024
					haveFree = true
				}
			}
		}
	}
	if !haveTotal {
		return 0, 0, false
	}
	if haveAvail && memAvail <= memTotal {
		return memTotal - memAvail, memTotal, true
	}
	if haveFree && memFree <= memTotal {
		return memTotal - memFree, memTotal, true
	}
	return 0, memTotal, false
}

func readDisk(path string) (used, total uint64, ok bool) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, 0, false
	}
	bs := uint64(st.Bsize)
	total = bs * uint64(st.Blocks)
	avail := bs * uint64(st.Bavail)
	if total == 0 || avail > total {
		return 0, 0, false
	}
	return total - avail, total, true
}

func readNetDevAggregate() (rx, tx uint64, ok bool) {
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return 0, 0, false
	}
	lines := strings.Split(string(b), "\n")
	var sumRx, sumTx uint64
	n := 0
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.Contains(line, "|") {
			continue
		}
		parts := strings.Split(line, ":")
		if len(parts) != 2 {
			continue
		}
		iface := strings.TrimSpace(parts[0])
		if iface == "lo" {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) < 9 {
			continue
		}
		rxb, err1 := strconv.ParseUint(fields[0], 10, 64)
		txb, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		sumRx += rxb
		sumTx += txb
		n++
	}
	if n == 0 {
		return 0, 0, false
	}
	return sumRx, sumTx, true
}

func readProcSelfRSS() (rssBytes uint64, ok bool) {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, false
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, false
		}
		return kb * 1024, true
	}
	return 0, false
}
