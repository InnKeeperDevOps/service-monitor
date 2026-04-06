import crypto from "node:crypto";

export type SessionInfo = {
  /** User id (matches `/me` and OAuth user.id). */
  id: string;
  /** Session row id; used to update active tenant. */
  sessionId: string;
  email: string;
  role: "owner" | "admin" | "operator" | "viewer";
  tenantId: string;
};

export type AuthStore = {
  findUserByEmail(email: string): Promise<{ id: string; email: string; passwordHash: string | null } | null>;
  findMemberships(userId: string): Promise<{ tenantId: string; role: string }[]>;
  findMembershipsWithTenants(
    userId: string
  ): Promise<{ tenantId: string; tenantName: string; role: string }[]>;
  createSession(userId: string, tenantId: string, tokenHash: string, expiresAt: Date): Promise<string>;
  findSessionByTokenHash(tokenHash: string): Promise<{ id: string; userId: string; tenantId: string; expiresAt: Date } | null>;
  findUserById(id: string): Promise<{ id: string; email: string } | null>;
  updateSessionTenant(sessionId: string, tenantId: string): Promise<boolean>;
  createTenantAsUser(args: {
    userId: string;
    sessionId: string;
    name: string;
    tenantId?: string;
  }): Promise<{ tenantId: string }>;
  deleteTenantForUser(args: { userId: string; tenantId: string }): Promise<
    "deleted" | "forbidden" | "not_found" | "protected"
  >;
};

const DEV_SESSION: SessionInfo = {
  id: "u-1",
  sessionId: "sess-dev",
  email: "admin@example.com",
  role: "owner",
  tenantId: "t-1"
};

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`${salt}:${derived.toString("hex")}`);
    });
  });
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return resolve(false);
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(Buffer.from(hash, "hex"), derived));
    });
  });
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export type LoginFailureReason =
  | "USER_NOT_FOUND"
  | "PASSWORD_NOT_SET"
  | "INVALID_PASSWORD"
  | "NO_MEMBERSHIP";

export type LoginTraceStep =
  | "LOOKUP_USER"
  | "USER_NOT_FOUND"
  | "PASSWORD_NOT_SET"
  | "VERIFY_PASSWORD"
  | "PASSWORD_VERIFIED"
  | "INVALID_PASSWORD"
  | "LOAD_MEMBERSHIPS"
  | "NO_MEMBERSHIP"
  | "CREATE_SESSION"
  | "SESSION_CREATED";

export type LoginAttemptResult =
  | { ok: true; session: SessionInfo; token: string; trace: LoginTraceStep[] }
  | { ok: false; reason: LoginFailureReason; trace: LoginTraceStep[] };

export async function loginWithDiagnostics(
  store: AuthStore,
  email: string,
  password: string
): Promise<LoginAttemptResult> {
  const trace: LoginTraceStep[] = ["LOOKUP_USER"];
  const user = await store.findUserByEmail(email);
  if (!user) return { ok: false, reason: "USER_NOT_FOUND", trace: [...trace, "USER_NOT_FOUND"] };
  if (!user.passwordHash) return { ok: false, reason: "PASSWORD_NOT_SET", trace: [...trace, "PASSWORD_NOT_SET"] };

  trace.push("VERIFY_PASSWORD");
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { ok: false, reason: "INVALID_PASSWORD", trace: [...trace, "INVALID_PASSWORD"] };
  trace.push("PASSWORD_VERIFIED");

  trace.push("LOAD_MEMBERSHIPS");
  const memberships = await store.findMemberships(user.id);
  const membership = memberships[0];
  if (!membership) return { ok: false, reason: "NO_MEMBERSHIP", trace: [...trace, "NO_MEMBERSHIP"] };

  trace.push("CREATE_SESSION");
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const sessionId = await store.createSession(user.id, membership.tenantId, tokenHash, expiresAt);
  trace.push("SESSION_CREATED");

  return {
    ok: true,
    trace,
    session: {
      id: user.id,
      sessionId,
      email: user.email,
      role: membership.role as SessionInfo["role"],
      tenantId: membership.tenantId,
    },
    token,
  };
}

export async function login(
  store: AuthStore,
  email: string,
  password: string
): Promise<{ session: SessionInfo; token: string } | null> {
  const result = await loginWithDiagnostics(store, email, password);
  return result.ok ? { session: result.session, token: result.token } : null;
}

export async function resolveSession(
  store: AuthStore,
  authHeader: string | undefined
): Promise<SessionInfo | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const allowDevToken =
    process.env.NODE_ENV !== "production" || process.env.SM_ALLOW_DEV_TOKEN === "1";
  if (token === "dev-token" && allowDevToken) {
    return DEV_SESSION;
  }

  const tokenHash = hashToken(token);
  const session = await store.findSessionByTokenHash(tokenHash);
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const user = await store.findUserById(session.userId);
  if (!user) return null;

  const memberships = await store.findMemberships(user.id);
  const membership = memberships.find((m) => m.tenantId === session.tenantId);
  if (!membership) return null;

  return {
    id: user.id,
    sessionId: session.id,
    email: user.email,
    role: membership.role as SessionInfo["role"],
    tenantId: membership.tenantId,
  };
}
