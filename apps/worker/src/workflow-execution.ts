import { executeWorkflow, type ExecutionContext, type NodeHandler } from "@sm/workflow-engine";
import { workflowExecutionJobSchema, type WorkflowExecutionJob } from "@sm/contracts";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execAsync = promisify(exec);

export async function runWorkflow(rawJob: unknown): Promise<{ success: boolean; log: string }> {
  const job = workflowExecutionJobSchema.parse(rawJob);
  const workspacePath = `/tmp/kaiad-workflows/${job.tenantId}/${job.workflowExecutionId}`;
  await fs.mkdir(workspacePath, { recursive: true });

  const handlers: Record<string, NodeHandler> = {
    agentStarted: async () => ({ success: true, output: "Triggered by agentStarted" }),
    onCrash: async () => ({ success: true, output: "Triggered by onCrash" }),
    clone: async (_nodeId: string, _node: any, _ctx: ExecutionContext) => {
      // In a real scenario, we might clone from a DB record, but we'll use a dummy or hardcoded approach here
      // For now, let's assume the user's `clone` step just works or we use a basic git clone if URL is provided in env
      return { success: true, output: `Clone skipped or simulated in ${workspacePath}` };
    },
    branchIf: async (_nodeId: string, node: any) => {
      const condition = String(node.data?.condition ?? "").trim().toLowerCase();
      const truthy = condition.length > 0 && condition !== "false" && condition !== "0";
      return {
        success: true,
        branchTaken: truthy ? "true" : "false",
        output: `Evaluated branchIf "${truthy ? "true" : "false"}"`
      };
    },
    if: async (_nodeId: string, node: any) => {
      const condition = String(node.data?.condition ?? "").trim().toLowerCase();
      const truthy = condition.length > 0 && condition !== "false" && condition !== "0";
      return {
        success: true,
        branchTaken: truthy ? "true" : "false",
        output: `Evaluated if "${truthy ? "true" : "false"}"`
      };
    },
    loop: async (_nodeId: string, node: any) => {
      const items = String(node.data?.items ?? "");
      return { success: true, output: `Looping over ${items}` };
    },
    wait: async (_nodeId: string, node: any) => {
      const durationStr = String(node.data?.duration ?? "0");
      const durationMs = parseInt(durationStr, 10);
      if (!isNaN(durationMs) && durationMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, durationMs));
      }
      return { success: true, output: `Waited ${durationMs}ms` };
    },
    join: async () => {
      return { success: true, output: `Join completed` };
    },
    split: async () => {
      return { success: true, output: `Split completed` };
    }
  };

  const buildTools = ["runShell", "runGradlew", "runPip", "runNpm", "runMaven", "runGo", "dockerBuild"];
  for (const tool of buildTools) {
    handlers[tool] = async (_nodeId: string, node: any, _ctx: ExecutionContext) => {
      let commandStr = String(node.data?.command ?? "");
      
      if (tool === "runGradlew") {
        commandStr = `./gradlew ${commandStr}`;
      } else if (tool === "runPip") {
        commandStr = `pip ${commandStr}`;
      } else if (tool === "runNpm") {
        commandStr = `npm ${commandStr}`;
      } else if (tool === "runMaven") {
        commandStr = `mvn ${commandStr}`;
      } else if (tool === "runGo") {
        commandStr = `go ${commandStr}`;
      }

      if (!commandStr.trim()) {
        commandStr = "echo 'No command provided'";
      }

      try {
        const { stdout, stderr } = await execAsync(commandStr, { cwd: workspacePath });
        return { success: true, output: stdout + (stderr ? `\n${stderr}` : "") };
      } catch (err) {
        return { success: false, output: err instanceof Error ? err.message : String(err) };
      }
    };
  }

  const initialContext: ExecutionContext = {
    env: {},
    outputs: {},
    triggerPayload: job.triggerPayload
  };

  const result = await executeWorkflow(job.nodes as any, job.edges as any, handlers, initialContext);

  let log = `Workflow Execution ${job.workflowExecutionId}\n`;
  for (const [nodeId, resRaw] of Object.entries(result.nodeResults)) {
    const res = resRaw as any;
    log += `[${nodeId}] Success: ${res.success}\nOutput: ${res.output}\n\n`;
  }

  return { success: result.success, log };
}