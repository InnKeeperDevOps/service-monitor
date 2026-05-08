// Package kaiad implements the operator's HTTP client for the Kaiad
// control-plane API.
//
// The operator authenticates with a long-lived API credential (created via
// POST /api/v1/admin/api-credentials) and uses it to mint short-TTL enrollment
// tokens that the agent pod consumes on first connect, and to poll agent
// status during reconciliation.
//
// Retry policy: 3 attempts with exponential backoff on 5xx and network errors.
// 4xx is not retried; the caller surfaces it as a permanent failure.
package kaiad

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Token mirrors POST /api/v1/agents/enrollment-tokens response shape.
type Token struct {
	ID        string
	Token     string
	ExpiresAt string
	AgentID   string // present once the platform has reserved a stable agent id
}

// AgentInfo mirrors GET /api/v1/agents/:id response shape (subset).
type AgentInfo struct {
	ID                 string
	Status             string
	WebsocketConnected bool
	LastSeenAt         string
}

// Client wraps the Kaiad HTTP API for the operator.
type Client struct {
	baseURL    string
	bearer     string
	httpClient *http.Client
	maxRetries int
}

// ClientOption configures a Client. Use NewClient with options to override
// defaults in tests.
type ClientOption func(*Client)

// WithHTTPClient overrides the inner http.Client (useful for tests/mocking).
func WithHTTPClient(h *http.Client) ClientOption {
	return func(c *Client) { c.httpClient = h }
}

// WithMaxRetries overrides the retry budget (default 3).
func WithMaxRetries(n int) ClientOption {
	return func(c *Client) { c.maxRetries = n }
}

// NewClient constructs a Client. baseURL is the API host (no trailing slash);
// bearer is a long-lived api-credential token with the appropriate scopes.
func NewClient(baseURL, bearer string, opts ...ClientOption) *Client {
	c := &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		bearer:     bearer,
		httpClient: &http.Client{Timeout: 30 * time.Second},
		maxRetries: 3,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// httpError captures HTTP failures the caller may want to inspect.
type httpError struct {
	status int
	body   string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("kaiad API: HTTP %d: %s", e.status, e.body)
}

// IsHTTPError reports whether err originated from a non-2xx response and
// returns the status code if so.
func IsHTTPError(err error) (int, bool) {
	var he *httpError
	if errors.As(err, &he) {
		return he.status, true
	}
	return 0, false
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var attempt error
	for i := 0; i <= c.maxRetries; i++ {
		if i > 0 {
			// Exponential backoff: 100ms * 2^(i-1) — 100ms, 200ms, 400ms.
			backoff := time.Duration(100*(1<<(i-1))) * time.Millisecond
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		var reqBody io.Reader
		if body != nil {
			raw, err := json.Marshal(body)
			if err != nil {
				return fmt.Errorf("kaiad API: marshal request: %w", err)
			}
			reqBody = bytes.NewReader(raw)
		}

		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
		if err != nil {
			return fmt.Errorf("kaiad API: build request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+c.bearer)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "kaiad-operator/0.1")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			attempt = fmt.Errorf("kaiad API: %w", err)
			continue // retry on transport error
		}

		respBody, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()

		switch {
		case resp.StatusCode >= 200 && resp.StatusCode < 300:
			if out == nil || len(respBody) == 0 {
				return nil
			}
			if err := json.Unmarshal(respBody, out); err != nil {
				return fmt.Errorf("kaiad API: decode response: %w", err)
			}
			return nil
		case resp.StatusCode >= 500:
			attempt = &httpError{status: resp.StatusCode, body: string(respBody)}
			continue
		default:
			// 4xx — permanent.
			return &httpError{status: resp.StatusCode, body: string(respBody)}
		}
	}
	if attempt == nil {
		attempt = errors.New("kaiad API: exhausted retries")
	}
	return attempt
}

type mintResponse struct {
	ID        string `json:"id"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	AgentID   string `json:"agentId,omitempty"`
}

// MintEnrollmentToken calls POST /api/v1/agents/enrollment-tokens.
func (c *Client) MintEnrollmentToken(ctx context.Context, ttlSeconds int) (Token, error) {
	if ttlSeconds <= 0 {
		return Token{}, errors.New("ttlSeconds must be positive")
	}
	var resp mintResponse
	if err := c.do(ctx, http.MethodPost, "/api/v1/agents/enrollment-tokens", map[string]int{"ttlSeconds": ttlSeconds}, &resp); err != nil {
		return Token{}, err
	}
	return Token{
		ID:        resp.ID,
		Token:     resp.Token,
		ExpiresAt: resp.ExpiresAt,
		AgentID:   resp.AgentID,
	}, nil
}

type agentResponse struct {
	ID                 string `json:"id"`
	Status             string `json:"status"`
	WebsocketConnected bool   `json:"websocketConnected"`
	LastSeenAt         string `json:"lastSeenAt"`
}

// GetAgent calls GET /api/v1/agents/:id. Returns IsHTTPError(err)==404 when the
// agent has not yet checked in with the platform.
func (c *Client) GetAgent(ctx context.Context, agentID string) (AgentInfo, error) {
	if agentID == "" {
		return AgentInfo{}, errors.New("agentID is required")
	}
	var resp agentResponse
	if err := c.do(ctx, http.MethodGet, "/api/v1/agents/"+agentID, nil, &resp); err != nil {
		return AgentInfo{}, err
	}
	return AgentInfo{
		ID:                 resp.ID,
		Status:             resp.Status,
		WebsocketConnected: resp.WebsocketConnected,
		LastSeenAt:         resp.LastSeenAt,
	}, nil
}
