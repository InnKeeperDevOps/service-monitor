import { describe, expect, it } from "vitest";
import { workflowJsonSchema } from "../src/features/workflow-editor/workflowSchema.js";

describe("workflowJsonSchema", () => {
  it("exports a JSON Schema object with WorkflowGraph definition", () => {
    expect(workflowJsonSchema).toBeDefined();
    expect(typeof workflowJsonSchema).toBe("object");
    const defs = workflowJsonSchema.definitions as Record<string, { type?: string; properties?: Record<string, unknown> }> | undefined;
    expect(defs?.WorkflowGraph).toBeDefined();
    expect(defs?.WorkflowGraph?.type).toBe("object");
    expect(defs?.WorkflowGraph?.properties).toMatchObject({
      id: expect.anything(),
      tenantId: expect.anything(),
      name: expect.anything(),
      version: expect.anything(),
      nodes: expect.anything(),
      edges: expect.anything(),
      isActive: expect.anything()
    });
  });
});
