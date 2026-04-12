import crypto from "node:crypto";
import type { Pool } from "pg";
import type { DomainStore } from "./domainStore.js";
import * as queries from "@sm/db";

function getEncryptionKey(): Buffer {
  const rawKey = process.env.KAIAD_ENCRYPTION_KEY;
  if (!rawKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("KAIAD_ENCRYPTION_KEY is required in production");
    }
    return crypto.createHash("sha256").update("dev-fallback-key").digest();
  }
  if (rawKey.length === 64) {
    return Buffer.from(rawKey, "hex");
  }
  return crypto.createHash("sha256").update(rawKey).digest();
}

function encryptSshKey(plaintext: string): string {
  const keyBytes = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${encrypted.toString("base64")}:${tag.toString("base64")}`;
}

export function createPostgresDomainStore(pool: Pool): DomainStore {
  const queryFn = async (sql: string, params: unknown[]) => {
    const result = await pool.query(sql, params);
    return { rows: result.rows as Record<string, unknown>[] };
  };

  return {
    listIncidents: (tenantId) => queries.listIncidents(queryFn, tenantId),
    getIncident: (tenantId, id) => queries.getIncident(queryFn, tenantId, id),
    upsertIncident: (tenantId, data) => queries.upsertIncident(queryFn, tenantId, data),
    updateIncidentStatus: (tenantId, id, status) =>
      queries.updateIncidentStatus(queryFn, tenantId, id, status),

    listSshKeys: async (tenantId) => {
      const rows = await queries.listSshKeys(queryFn, tenantId);
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        name: r.name,
        type: r.type as "uploaded" | "local_path",
        localPath: r.localPath ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      }));
    },
    createSshKey: async (tenantId, data) => {
      let privateKeyEncrypted: string | undefined = undefined;
      if (data.privateKey) {
        privateKeyEncrypted = encryptSshKey(data.privateKey);
      }
      const row = await queries.createSshKey(queryFn, tenantId, {
        name: data.name,
        type: data.type,
        localPath: data.localPath,
        privateKeyEncrypted
      });
      return {
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        type: row.type as "uploaded" | "local_path",
        localPath: row.localPath ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    },
    deleteSshKey: (tenantId, id) => queries.deleteSshKey(queryFn, tenantId, id),

    listAgents: (tenantId) => queries.listAgents(queryFn, tenantId),
    getAgent: (tenantId, id) => queries.getAgent(queryFn, tenantId, id),
    recordAgentHeartbeat: (tenantId, data) =>
      queries.recordAgentHeartbeat(queryFn, tenantId, data),
    markAgentOffline: (tenantId, agentId) => queries.markAgentOffline(queryFn, tenantId, agentId),
    listServices: (tenantId) => queries.listServices(queryFn, tenantId),
    getService: (tenantId, id) => queries.getService(queryFn, tenantId, id),
    createService: (tenantId, data) => queries.createService(queryFn, tenantId, data),
    updateServiceWorkflow: (tenantId, serviceId, workflowGraphId) =>
      queries.updateServiceWorkflow(queryFn, tenantId, serviceId, workflowGraphId),
    deleteService: async (tenantId, id) => {
      const { rows } = await queryFn(
        "DELETE FROM monitored_services WHERE id = $1 AND tenant_id = $2 RETURNING id",
        [id, tenantId]
      );
      return rows.length > 0;
    },
    listWorkflowGraphs: (tenantId) => queries.listWorkflowGraphs(queryFn, tenantId),
    getWorkflowGraph: (tenantId, workflowId) => queries.getWorkflowGraph(queryFn, tenantId, workflowId),
    createWorkflowGraph: (tenantId, data) => queries.createWorkflowGraph(queryFn, tenantId, data)
  } as DomainStore;
}
