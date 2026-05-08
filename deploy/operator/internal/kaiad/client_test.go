package kaiad

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMintEnrollmentToken_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agents/enrollment-tokens" || r.Method != http.MethodPost {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer cred-1" {
			t.Errorf("auth header: %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		var parsed map[string]int
		_ = json.Unmarshal(body, &parsed)
		if parsed["ttlSeconds"] != 300 {
			t.Errorf("ttlSeconds: %d", parsed["ttlSeconds"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id":        "tok-1",
			"token":     "enroll-secret",
			"expiresAt": "2026-05-08T20:14:02Z",
			"agentId":   "agt-future-1",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "cred-1")
	tok, err := c.MintEnrollmentToken(context.Background(), 300)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if tok.Token != "enroll-secret" || tok.ID != "tok-1" || tok.AgentID != "agt-future-1" {
		t.Errorf("token decoded wrong: %+v", tok)
	}
}

func TestMintEnrollmentToken_RetriesOn5xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n < 3 {
			http.Error(w, "boom", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id": "tok-1", "token": "x", "expiresAt": "2026-05-08T00:00:00Z",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "cred", WithMaxRetries(5))
	c.httpClient.Timeout = 2 * time.Second
	if _, err := c.MintEnrollmentToken(context.Background(), 300); err != nil {
		t.Fatalf("expected eventual success, got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Errorf("expected 3 calls, got %d", got)
	}
}

func TestMintEnrollmentToken_DoesNotRetry4xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, `{"code":"FORBIDDEN","message":"missing scope"}`, http.StatusForbidden)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "cred", WithMaxRetries(5))
	_, err := c.MintEnrollmentToken(context.Background(), 300)
	if err == nil {
		t.Fatal("expected error")
	}
	if status, ok := IsHTTPError(err); !ok || status != http.StatusForbidden {
		t.Errorf("expected HTTP 403, got status=%d ok=%v err=%v", status, ok, err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("expected exactly 1 call (no retry on 4xx), got %d", got)
	}
}

func TestGetAgent_404IsExposedAsHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/v1/agents/") {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		http.Error(w, `{"code":"NOT_FOUND"}`, http.StatusNotFound)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "cred")
	_, err := c.GetAgent(context.Background(), "agt-missing")
	if err == nil {
		t.Fatal("expected 404 error")
	}
	if status, ok := IsHTTPError(err); !ok || status != http.StatusNotFound {
		t.Errorf("expected HTTP 404, got %d ok=%v", status, ok)
	}
}

func TestGetAgent_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agents/agt-1" {
			t.Errorf("path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":                 "agt-1",
			"status":             "online",
			"websocketConnected": true,
			"lastSeenAt":         "2026-05-08T20:00:00Z",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "cred")
	info, err := c.GetAgent(context.Background(), "agt-1")
	if err != nil {
		t.Fatalf("getAgent: %v", err)
	}
	if info.Status != "online" || !info.WebsocketConnected {
		t.Errorf("agent decoded wrong: %+v", info)
	}
}

func TestMintEnrollmentToken_ValidatesTTL(t *testing.T) {
	c := NewClient("http://localhost", "cred")
	if _, err := c.MintEnrollmentToken(context.Background(), 0); err == nil {
		t.Error("expected error for ttl=0")
	}
}
