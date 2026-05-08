import { describe, expect, it, beforeEach } from "vitest";
import {
  normalizeErrorMessage,
  isProbablyUserInputError,
  fingerprintError,
  ErrorGroupStore
} from "../src/errorGrouping.js";

describe("normalizeErrorMessage", () => {
  it("strips uuids", () => {
    const a = normalizeErrorMessage("user 123e4567-e89b-12d3-a456-426614174000 not found");
    const b = normalizeErrorMessage("user 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d not found");
    expect(a).toBe(b);
  });

  it("strips IPs and ports", () => {
    const a = normalizeErrorMessage("connection refused 10.0.0.1:5432");
    const b = normalizeErrorMessage("connection refused 192.168.1.1:5432");
    expect(a).toBe(b);
  });

  it("strips long numeric ids but keeps shape", () => {
    const a = normalizeErrorMessage("missing record id=1023495");
    const b = normalizeErrorMessage("missing record id=8881122");
    expect(a).toBe(b);
    expect(a).toContain("<N>");
  });

  it("strips timestamps", () => {
    const a = normalizeErrorMessage("2026-04-27T10:00:00Z error: db down");
    const b = normalizeErrorMessage("2025-01-15T22:18:42.123Z error: db down");
    expect(a).toBe(b);
  });

  it("collapses quoted user input", () => {
    const a = normalizeErrorMessage('parse failed: "alice@example.com"');
    const b = normalizeErrorMessage('parse failed: "bob@example.com"');
    expect(a).toBe(b);
  });

  it("preserves the main error shape", () => {
    expect(normalizeErrorMessage("ECONNREFUSED")).toContain("ECONNREFUSED");
  });
});

describe("isProbablyUserInputError", () => {
  it("filters 4xx-style messages", () => {
    expect(isProbablyUserInputError("HTTP 400 bad request")).toBe(true);
    expect(isProbablyUserInputError("validation failed: email is required")).toBe(true);
    expect(isProbablyUserInputError("invalid input: id must be a string")).toBe(true);
    expect(isProbablyUserInputError("Unauthorized")).toBe(true);
    expect(isProbablyUserInputError("ZodError: ...")).toBe(true);
  });

  it("does NOT filter server-side bug messages", () => {
    expect(isProbablyUserInputError("ECONNREFUSED 127.0.0.1:5432")).toBe(false);
    expect(isProbablyUserInputError("TypeError: cannot read property foo of null")).toBe(false);
    expect(isProbablyUserInputError("Internal server error: db connection lost")).toBe(false);
    expect(isProbablyUserInputError("uncaught exception in worker")).toBe(false);
  });
});

describe("fingerprintError", () => {
  it("returns the same hash for the same normalized message", () => {
    const a = fingerprintError("svc-1", "ECONNREFUSED <IP>");
    const b = fingerprintError("svc-1", "ECONNREFUSED <IP>");
    expect(a).toBe(b);
  });
  it("differs across services", () => {
    const a = fingerprintError("svc-1", "ECONNREFUSED <IP>");
    const b = fingerprintError("svc-2", "ECONNREFUSED <IP>");
    expect(a).not.toBe(b);
  });
});

describe("ErrorGroupStore", () => {
  let store: ErrorGroupStore;
  beforeEach(() => {
    store = new ErrorGroupStore();
  });

  it("dedups errors with id-only differences into one group", () => {
    const a = store.upsert({
      tenantId: "t1",
      agentId: "a1",
      serviceId: "svc",
      message: "user 12345 not found",
      contextLines: ["L1", "L2"],
      ts: "2026-04-27T10:00:00Z"
    });
    const b = store.upsert({
      tenantId: "t1",
      agentId: "a1",
      serviceId: "svc",
      message: "user 99999 not found",
      contextLines: ["L3"],
      ts: "2026-04-27T10:00:01Z"
    });
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(false);
    expect(b.group.id).toBe(a.group.id);
    expect(b.group.count).toBe(2);
  });

  it("creates separate groups for different services", () => {
    const a = store.upsert({
      tenantId: "t1",
      agentId: "a1",
      serviceId: "svc-A",
      message: "boom",
      contextLines: [],
      ts: "2026-04-27T10:00:00Z"
    });
    const b = store.upsert({
      tenantId: "t1",
      agentId: "a1",
      serviceId: "svc-B",
      message: "boom",
      contextLines: [],
      ts: "2026-04-27T10:00:00Z"
    });
    expect(a.group.id).not.toBe(b.group.id);
  });

  it("pauses if the same fingerprint reappears within 30min of a fix", () => {
    const r = store.upsert({
      tenantId: "t1",
      agentId: "a1",
      serviceId: "svc",
      message: "ECONNREFUSED 127.0.0.1",
      contextLines: [],
      ts: "2026-04-27T10:00:00Z"
    });
    store.setStatus(r.group.id, "fixed", "abc1234", "2026-04-27T10:05:00Z");
    const reoccurrence = store.upsert({
      tenantId: "t1",
      agentId: "a1",
      serviceId: "svc",
      message: "ECONNREFUSED 127.0.0.1",
      contextLines: [],
      ts: "2026-04-27T10:10:00Z"
    });
    expect(reoccurrence.group.status).toBe("paused");
  });

  it("does NOT pause if the reoccurrence is more than 30min after the fix", () => {
    const r = store.upsert({
      tenantId: "t1",
      agentId: "a1",
      serviceId: "svc",
      message: "ECONNREFUSED 127.0.0.1",
      contextLines: [],
      ts: "2026-04-27T10:00:00Z"
    });
    store.setStatus(r.group.id, "fixed", "abc1234", "2026-04-27T10:05:00Z");
    const reoccurrence = store.upsert({
      tenantId: "t1",
      agentId: "a1",
      serviceId: "svc",
      message: "ECONNREFUSED 127.0.0.1",
      contextLines: [],
      ts: "2026-04-27T11:00:00Z"
    });
    expect(reoccurrence.group.status).toBe("fixed");
  });
});
