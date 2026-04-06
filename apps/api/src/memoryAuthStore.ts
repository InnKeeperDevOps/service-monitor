import crypto from "node:crypto";
import { hashPassword, type AuthStore } from "./auth.js";

type UserRow = { id: string; email: string; passwordHash: string | null };
type MembershipRow = { tenantId: string; userId: string; role: string };
type SessionRow = { id: string; userId: string; tenantId: string; tokenHash: string; expiresAt: Date };

let users: Map<string, UserRow>;
let memberships: MembershipRow[];
let sessions: Map<string, SessionRow>;
let tenantNames: Map<string, string>;

function init() {
  users = new Map();
  memberships = [];
  sessions = new Map();
  tenantNames = new Map();
}

init();

export function __resetAuthStoreForTests(): void {
  init();
}

export function createMemoryAuthStore(): AuthStore {
  return {
    async findUserByEmail(email) {
      for (const u of users.values()) {
        if (u.email === email) return u;
      }
      return null;
    },
    async findMemberships(userId) {
      return memberships
        .filter((r) => r.userId === userId)
        .map((r) => ({ tenantId: r.tenantId, role: r.role }));
    },
    async findMembershipsWithTenants(userId) {
      return memberships
        .filter((r) => r.userId === userId)
        .map((r) => ({
          tenantId: r.tenantId,
          tenantName: tenantNames.get(r.tenantId) ?? r.tenantId,
          role: r.role,
        }))
        .sort((a, b) => a.tenantName.localeCompare(b.tenantName));
    },
    async createSession(userId, tenantId, tokenHash, expiresAt) {
      const id = `sess-${crypto.randomUUID()}`;
      sessions.set(id, { id, userId, tenantId, tokenHash, expiresAt });
      return id;
    },
    async findSessionByTokenHash(tokenHash) {
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) return s;
      }
      return null;
    },
    async updateSessionTenant(sessionId, tenantId) {
      const s = sessions.get(sessionId);
      if (!s) return false;
      s.tenantId = tenantId;
      return true;
    },
    async findUserById(id) {
      const u = users.get(id);
      return u ? { id: u.id, email: u.email } : null;
    },

    async createTenantAsUser({ userId, sessionId, name, tenantId: explicitId }) {
      const id = explicitId ?? `t-${crypto.randomUUID()}`;
      if (tenantNames.has(id)) {
        throw Object.assign(new Error("Tenant id already exists"), { code: "TENANT_ID_TAKEN" });
      }
      const s = sessions.get(sessionId);
      if (!s || s.userId !== userId) {
        throw new Error("SESSION_UPDATE_FAILED");
      }
      tenantNames.set(id, name);
      memberships.push({ tenantId: id, userId, role: "owner" });
      s.tenantId = id;
      return { tenantId: id };
    },

    async deleteTenantForUser({ userId, tenantId }) {
      const protectedIds = new Set(
        [process.env.DEFAULT_WEBHOOK_TENANT_ID, process.env.SM_DEFAULT_TENANT_ID].filter(Boolean) as string[]
      );
      if (protectedIds.has(tenantId)) {
        return "protected";
      }
      if (!tenantNames.has(tenantId)) {
        return "not_found";
      }
      const row = memberships.find((r) => r.userId === userId && r.tenantId === tenantId);
      if (!row) {
        return "forbidden";
      }
      if (row.role !== "owner" && row.role !== "admin") {
        return "forbidden";
      }

      for (const sess of [...sessions.values()]) {
        if (sess.tenantId !== tenantId) continue;
        const alts = memberships
          .filter((r) => r.userId === sess.userId && r.tenantId !== tenantId)
          .map((r) => ({
            tenantId: r.tenantId,
            sortName: tenantNames.get(r.tenantId) ?? r.tenantId,
          }))
          .sort((a, b) => a.sortName.localeCompare(b.sortName));
        if (alts.length > 0) {
          sess.tenantId = alts[0].tenantId;
        } else {
          sessions.delete(sess.id);
        }
      }

      for (let i = memberships.length - 1; i >= 0; i--) {
        if (memberships[i].tenantId === tenantId) {
          memberships.splice(i, 1);
        }
      }
      tenantNames.delete(tenantId);
      return "deleted";
    },
  };
}

export async function seedDevUser(store: AuthStore): Promise<void> {
  const passwordHash = await hashPassword("admin");
  const user: UserRow = { id: "u-1", email: "admin@example.com", passwordHash };
  users.set(user.id, user);
  memberships.push({ tenantId: "t-1", userId: "u-1", role: "owner" });
  tenantNames.set("t-1", "Dev");
}

/** Test helper: add another tenant membership for a user (memory store only). */
export function addMemoryMembershipForTests(opts: {
  tenantId: string;
  userId: string;
  role: string;
  tenantName?: string;
}): void {
  memberships.push({ tenantId: opts.tenantId, userId: opts.userId, role: opts.role });
  if (opts.tenantName) {
    tenantNames.set(opts.tenantId, opts.tenantName);
  }
}
