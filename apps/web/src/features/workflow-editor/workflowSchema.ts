import { zodToJsonSchema } from "zod-to-json-schema";
import { workflowGraphSchema } from "@sm/contracts";

// Generate JSON Schema from Zod schema
export const workflowJsonSchema = zodToJsonSchema(workflowGraphSchema, "WorkflowGraph");
