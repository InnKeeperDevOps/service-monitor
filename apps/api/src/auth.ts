import crypto from "node:crypto";

export type SessionInfo = {
  id: string;
  email: string;
  role: "owner" | "admin" | "operator" | "viewer";
  tenantId: string;
};

export type AuthStore = {
  findUserByEmail(email: string): Promise<{ id: string; email: string; passwordHash: string | null } | null>;
  findMemberships(userId: string): Promise<{ tenantId: string; role: string }[]>;
  createSession(userId: string, tenantId: string, tokenHash: string, expiresAt: Date): Promise<string>;
  findSessionByTokenHash(tokenHash: string): Promise<{ id: string; userId: string; tenantId: string; expiresAt: Date } | null>;
  findUserById(id: string): Promise<{ id: string; email: string } | null>;
};

const DEV_SESSION: SessionInfo = { id: "u-1", email: "admin@example.com", role: "owner", tenantId: "t-1" };

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

export async function login(
  store: AuthStore,
  email: string,
  password: string
): Promise<{ session: SessionInfo; token: string } | null> {
  const user = await store.findUserByEmail(email);
  if (!user || !user.passwordHash) return null;

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;

  const memberships = await store.findMemberships(user.id);
  const membership = memberships[0];
  if (!membership) return null;

  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const sessionId = await store.createSession(user.id, membership.tenantId, tokenHash, expiresAt);

  return {
    session: {
      id: sessionId,
      email: user.email,
      role: membership.role as SessionInfo["role"],
      tenantId: membership.tenantId,
    },
    token,
  };
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
    id: session.id,
    email: user.email,
    role: membership.role as SessionInfo["role"],
    tenantId: membership.tenantId,
  };
}
