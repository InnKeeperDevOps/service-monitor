import crypto from "node:crypto";
import { hashPassword, type AuthStore } from "./auth.js";

type UserRow = { id: string; email: string; passwordHash: string | null };
type MembershipRow = { tenantId: string; userId: string; role: string };
type SessionRow = { id: string; userId: string; tenantId: string; tokenHash: string; expiresAt: Date };

let users: Map<string, UserRow>;
let memberships: MembershipRow[];
let sessions: Map<string, SessionRow>;

function init() {
  users = new Map();
  memberships = [];
  sessions = new Map();
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
    async findUserById(id) {
      const u = users.get(id);
      return u ? { id: u.id, email: u.email } : null;
    },
  };
}

export async function seedDevUser(store: AuthStore): Promise<void> {
  const passwordHash = await hashPassword("admin");
  const user: UserRow = { id: "u-1", email: "admin@example.com", passwordHash };
  users.set(user.id, user);
  memberships.push({ tenantId: "t-1", userId: "u-1", role: "owner" });
}
