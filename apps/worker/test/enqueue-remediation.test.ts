import { describe, expect, it, vi } from "vitest";
import type { RemediationJob } from "@sm/contracts";
import { enqueueRemediationJob } from "../src/index.js";

const sampleJob: RemediationJob = {
  remediationJobId: "r-1",
  tenantId: "t-1",
  incidentId: "i-1",
  fingerprint: "fp",
  executor: "cursor",
  prompt: "fix it"
};

describe("enqueueRemediationJob", () => {
  it("delegates to queue.add with remediation job name and payload", async () => {
    const add = vi.fn().mockResolvedValue({ id: "job-1" });
    const queue = { add };
    const result = await enqueueRemediationJob(queue, sampleJob);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith("remediation", sampleJob, undefined);
    expect(result).toEqual({ id: "job-1" });
  });

  it("forwards optional BullMQ job options", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const queue = { add };
    await enqueueRemediationJob(queue, sampleJob, { attempts: 3 });
    expect(add).toHaveBeenCalledWith("remediation", sampleJob, { attempts: 3 });
  });
});
