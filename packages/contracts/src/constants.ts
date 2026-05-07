export const API_PREFIX = "/api/v1";

export const QUEUE_NAMES = {
  remediation: "remediation",
  github: "github",
  agentCommands: "agent-commands",
  logIngestion: "log-ingestion"
} as const;

export const CORRELATION_HEADER = "x-correlation-id";
