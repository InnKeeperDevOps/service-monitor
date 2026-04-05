import crypto from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { CORRELATION_HEADER } from "@sm/contracts";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

export const correlationIdPlugin = fp(async function (app: FastifyInstance) {
  app.decorateRequest("correlationId", "");

  app.addHook("onRequest", async (req, reply) => {
    const existing = req.headers[CORRELATION_HEADER];
    const correlationId =
      typeof existing === "string" && existing.length > 0
        ? existing
        : crypto.randomUUID();
    req.correlationId = correlationId;
    reply.header(CORRELATION_HEADER, correlationId);
  });
});
