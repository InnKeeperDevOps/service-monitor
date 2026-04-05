import crypto from "node:crypto";
import type { QueryFn } from "./queries.js";

export type AuditEntry = {
  tenantId: string;
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
};

export async function writeAuditLog(query: QueryFn, entry: AuditEntry): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO audit_logs (id, tenant_id, actor_id, action, target_type, target_id, metadata_json) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, entry.tenantId, entry.actorId ?? null, entry.action, entry.targetType, entry.targetId ?? null, JSON.stringify(entry.metadata ?? {})]
  );
  return id;
}

export async function listAuditLogs(query: QueryFn, tenantId: string, limit = 50): Promise<AuditEntry[]> {
  const { rows } = await query(
    `SELECT tenant_id, actor_id, action, target_type, target_id, metadata_json FROM audit_logs WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2`,
    [tenantId, limit]
  );
  return rows.map(r => ({
    tenantId: String(r.tenant_id),
    actorId: r.actor_id ? String(r.actor_id) : undefined,
    action: String(r.action),
    targetType: String(r.target_type),
    targetId: r.target_id ? String(r.target_id) : undefined,
    metadata: typeof r.metadata_json === 'string' ? JSON.parse(r.metadata_json) : (r.metadata_json as Record<string, unknown>)
  }));
}
