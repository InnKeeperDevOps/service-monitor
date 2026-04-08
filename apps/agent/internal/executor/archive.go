package executor

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const defaultArtifactMaxBytes = 512 * 1024 * 1024

func artifactMaxBytes() int64 {
	raw := strings.TrimSpace(os.Getenv("SM_ARTIFACT_MAX_BYTES"))
	if raw == "" {
		return defaultArtifactMaxBytes
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		log.Printf("[agent:executor] invalid SM_ARTIFACT_MAX_BYTES %q, using default %d", raw, defaultArtifactMaxBytes)
		return defaultArtifactMaxBytes
	}
	return n
}

func artifactFetchTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv("SM_ARTIFACT_FETCH_TIMEOUT_MS"))
	if raw == "" {
		return 30 * time.Minute
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms <= 0 {
		return 30 * time.Minute
	}
	return time.Duration(ms) * time.Millisecond
}

func allowHTTPArtifactURLs() bool {
	return strings.TrimSpace(os.Getenv("SM_ARTIFACT_ALLOW_HTTP")) == "1"
}

func validateArtifactURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("parse url: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return nil
	case "http":
		if allowHTTPArtifactURLs() {
			return nil
		}
		return fmt.Errorf("only https URLs are allowed (set SM_ARTIFACT_ALLOW_HTTP=1 for http)")
	default:
		return fmt.Errorf("unsupported url scheme %q", u.Scheme)
	}
}

// stripTarMemberName removes the first `strip` path segments from a tar member name (tar uses slash separators).
func stripTarMemberName(name string, strip int) string {
	name = strings.TrimSpace(name)
	name = strings.TrimPrefix(filepath.ToSlash(name), "/")
	if name == "" || name == "." {
		return ""
	}
	parts := strings.Split(name, "/")
	var keep []string
	for _, p := range parts {
		if p == "" || p == "." {
			continue
		}
		keep = append(keep, p)
	}
	if len(keep) == 0 {
		return ""
	}
	if strip >= len(keep) {
		return ""
	}
	return strings.Join(keep[strip:], "/")
}

func pathWithinDest(destRoot, member string) error {
	cleanDest := filepath.Clean(destRoot)
	joined := filepath.Join(cleanDest, filepath.FromSlash(member))
	cleanJoined := filepath.Clean(joined)
	rel, err := filepath.Rel(cleanDest, cleanJoined)
	if err != nil {
		return fmt.Errorf("path escapes destination: %w", err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("path escapes destination")
	}
	return nil
}

// extractTarGz extracts gzip-compressed tar from r into dest. Only regular files and directories are allowed.
func extractTarGz(ctx context.Context, r io.Reader, dest string, strip int) error {
	dest = filepath.Clean(dest)
	gzr, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("gzip header: %w", err)
	}
	defer func() {
		if cerr := gzr.Close(); cerr != nil {
			log.Printf("[agent:executor] gzip close: %v", cerr)
		}
	}()

	tr := tar.NewReader(gzr)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("tar header: %w", err)
		}

		member := stripTarMemberName(hdr.Name, strip)
		if member == "" || member == "." {
			if hdr.Typeflag == tar.TypeDir {
				continue
			}
			if hdr.Typeflag == tar.TypeReg || hdr.Typeflag == tar.TypeRegA {
				// Stripped to nothing — skip empty file entries
				if _, err := io.Copy(io.Discard, tr); err != nil {
					return fmt.Errorf("skip stripped file: %w", err)
				}
			}
			continue
		}

		if err := pathWithinDest(dest, member); err != nil {
			return fmt.Errorf("illegal path in archive %q: %w", hdr.Name, err)
		}

		target := filepath.Join(dest, filepath.FromSlash(member))
		cleanTarget := filepath.Clean(target)

		mode := fs.FileMode(hdr.Mode) & 0o777
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(cleanTarget, mode|0o111); err != nil {
				return fmt.Errorf("mkdir %s: %w", cleanTarget, err)
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(cleanTarget), 0o755); err != nil {
				return fmt.Errorf("mkdir parent: %w", err)
			}
			f, err := os.OpenFile(cleanTarget, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return fmt.Errorf("create %s: %w", cleanTarget, err)
			}
			n, copyErr := io.Copy(f, tr)
			closeErr := f.Close()
			if copyErr != nil {
				return fmt.Errorf("write %s: %w", cleanTarget, copyErr)
			}
			if n != hdr.Size {
				return fmt.Errorf("short write %s: got %d want %d", cleanTarget, n, hdr.Size)
			}
			if closeErr != nil {
				return fmt.Errorf("close %s: %w", cleanTarget, closeErr)
			}
		default:
			return fmt.Errorf("unsupported tar entry type %d for %s", hdr.Typeflag, hdr.Name)
		}
	}
}

func fetchArtifact(ctx context.Context, rawURL string) (io.ReadCloser, error) {
	if err := validateArtifactURL(rawURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	req.Header.Set("User-Agent", "service-monitor-agent/1.0")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http get: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		_ = resp.Body.Close()
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return resp.Body, nil
}

func intFromPayload(payload map[string]interface{}, key string) int {
	switch v := payload[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	default:
		return 0
	}
}

func (e *Executor) executeReceiveSourceArchive(ctx context.Context, payload map[string]interface{}) CommandResult {
	urlStr := strings.TrimSpace(stringValue(payload["url"]))
	archivePath := strings.TrimSpace(stringValue(payload["archivePath"]))
	if (urlStr == "") == (archivePath == "") {
		return CommandResult{Success: false, Output: "provide exactly one of url or archivePath"}
	}

	destDir := strings.TrimSpace(stringValue(payload["destDir"]))
	var err error
	if destDir == "" {
		destDir, err = ensureWorkspace("")
		if err != nil {
			return CommandResult{Success: false, Output: fmt.Sprintf("resolve destDir: %v", err)}
		}
	} else {
		destDir, err = filepath.Abs(destDir)
		if err != nil {
			return CommandResult{Success: false, Output: fmt.Sprintf("destDir: %v", err)}
		}
		if err := os.MkdirAll(destDir, 0o755); err != nil {
			return CommandResult{Success: false, Output: fmt.Sprintf("mkdir destDir: %v", err)}
		}
	}

	strip := intFromPayload(payload, "stripComponents")
	if strip < 0 {
		strip = 0
	}

	maxBytes := artifactMaxBytes()
	fetchCtx, cancel := context.WithTimeout(ctx, artifactFetchTimeout())
	defer cancel()

	var body io.ReadCloser
	if urlStr != "" {
		body, err = fetchArtifact(fetchCtx, urlStr)
		if err != nil {
			return CommandResult{Success: false, Output: err.Error()}
		}
	} else {
		body, err = os.Open(archivePath)
		if err != nil {
			return CommandResult{Success: false, Output: fmt.Sprintf("open archive: %v", err)}
		}
	}
	defer func() {
		if cerr := body.Close(); cerr != nil {
			log.Printf("[agent:executor] artifact body close: %v", cerr)
		}
	}()

	limited := &io.LimitedReader{R: body, N: maxBytes + 1}
	if err := extractTarGz(fetchCtx, limited, destDir, strip); err != nil {
		return CommandResult{Success: false, Output: err.Error()}
	}
	if limited.N == 0 {
		return CommandResult{
			Success: false,
			Output:  fmt.Sprintf("artifact exceeds max size (%d bytes); raise SM_ARTIFACT_MAX_BYTES if needed", maxBytes),
		}
	}

	return CommandResult{Success: true, Output: fmt.Sprintf("extracted source archive into %s", destDir)}
}
