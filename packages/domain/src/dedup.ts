import { createHash } from "node:crypto";

const volatileTokens = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\bpid=\d+\b/gi,
  /\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}\.\d+z\b/gi
];

export function normalizeError(message: string): string {
  return volatileTokens.reduce(
    (acc, pattern) => acc.replace(pattern, "<redacted>"),
    message.toLowerCase().trim()
  );
}

export function fingerprintError(message: string, topStackFrames: string[] = []): string {
  const normalized = normalizeError(message);
  const base = `${normalized}::${topStackFrames.slice(0, 5).join("|")}`;
  return createHash("sha256").update(base).digest("hex");
}
