import { describe, it, expect, vi } from "vitest";
import {
  resolveDeps,
  substituteString,
  substitutePipeline,
  BuildDepsError
} from "../src/builddeps.js";
import type { QueryFn } from "@sm/db";
import type { PipelineDefinition } from "@sm/contracts";

const q = (rows: Record<string, unknown>[]): QueryFn =>
  vi.fn().mockResolvedValue({ rows }) as unknown as QueryFn;

describe("substituteString", () => {
  it("substitutes known vars and reports missing ones", () => {
    const r = substituteString("img reg/{foo_version}:{bar} done", { foo_version: "abc" });
    expect(r.out).toBe("img reg/abc:{bar} done");
    expect(r.missing).toEqual(["bar"]);
  });
  it("leaves a string with no placeholders unchanged", () => {
    expect(substituteString("plain text", {})).toEqual({ out: "plain text", missing: [] });
  });
});

describe("substitutePipeline", () => {
  it("deep-walks and substitutes every string, collecting misses", () => {
    const pipeline = {
      dependsOn: [],
      runtime: { image: "reg/{foo_version}", command: ["run", "{unknown_a}"] },
      steps: [{ run: "echo {foo_version}" }, { run: "echo {unknown_b}" }],
      flag: true,
      count: 3
    } as unknown as PipelineDefinition;
    const { pipeline: out, missing } = substitutePipeline(pipeline, { foo_version: "v1" });
    const o = out as unknown as Record<string, any>;
    expect(o.runtime.image).toBe("reg/v1");
    expect(o.steps[0].run).toBe("echo v1");
    expect(o.flag).toBe(true);
    expect(o.count).toBe(3);
    expect(missing.sort()).toEqual(["unknown_a", "unknown_b"]);
  });
});

describe("resolveDeps", () => {
  const pl = (dependsOn: string[]) => ({ dependsOn }) as unknown as PipelineDefinition;

  it("returns system registry vars and no deps when dependsOn is empty", async () => {
    const { vars, resolved } = await resolveDeps(q([]), "t-1", pl([]), {
      registryHost: "panel.kaiad.dev",
      registryInternal: "127.0.0.1:8091"
    });
    expect(vars.kaiad_registry_host).toBe("panel.kaiad.dev");
    expect(vars.kaiad_registry_internal).toBe("127.0.0.1:8091");
    expect(resolved).toEqual([]);
  });

  it("resolves a dependency's latest successful build into vars", async () => {
    const sha = "abcdef1234567890abcd";
    const { vars, resolved } = await resolveDeps(
      q([{ id: "bld-1", service_id: "svc-foo", git_sha: sha, image_ref: `reg/foo:${sha}` }]),
      "t-1",
      pl(["foo"])
    );
    expect(vars.foo_version).toBe(sha);
    expect(vars.foo_short_version).toBe(sha.slice(0, 12));
    expect(vars.foo_build_id).toBe("bld-1");
    expect(vars.foo_image_ref).toBe(`reg/foo:${sha}`);
    expect(vars.foo_image).toBe("reg/foo");
    expect(resolved).toHaveLength(1);
  });

  it("throws BuildDepsError when a dependency has no successful build", async () => {
    await expect(resolveDeps(q([]), "t-1", pl(["bar"]))).rejects.toBeInstanceOf(BuildDepsError);
  });
});
