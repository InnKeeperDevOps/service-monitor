import { describe, expect, it } from "vitest";
import { parsePipelineYaml } from "../src/pipeline.js";

describe("parsePipelineYaml", () => {
  it("accepts a minimal valid pipeline", () => {
    const r = parsePipelineYaml(`
version: 1
build:
  image: alpine:3.20
  steps:
    - echo hello > /artifacts/out.txt
artifacts:
  - out.txt
runtime:
  image: alpine:3.20
  copy:
    - from: out.txt
      to: /out.txt
  command: ["cat", "/out.txt"]
ports:
  - port: 8080
    name: http
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pipeline.build?.image).toBe("alpine:3.20");
    expect(r.pipeline.runtime?.image).toBe("alpine:3.20");
    expect(r.pipeline.ports[0]).toEqual({ port: 8080, name: "http", protocol: "TCP" });
  });

  it("rejects unknown version", () => {
    const r = parsePipelineYaml(`version: 2\nbuild:\n  image: alpine\n  steps: [echo]\n`);
    expect(r.ok).toBe(false);
  });

  it("rejects copy.from not present in artifacts[]", () => {
    const r = parsePipelineYaml(`
version: 1
artifacts: ["a.jar"]
runtime:
  image: alpine
  copy:
    - from: typo.jar
      to: /app.jar
  command: ["sh"]
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/typo\.jar/);
  });

  it("rejects path traversal in artifacts", () => {
    const r = parsePipelineYaml(`
version: 1
artifacts: ["../../etc/passwd"]
`);
    expect(r.ok).toBe(false);
  });

  it("rejects absolute artifact paths", () => {
    const r = parsePipelineYaml(`
version: 1
artifacts: ["/etc/passwd"]
`);
    expect(r.ok).toBe(false);
  });

  it("requires runtime.copy.to to be absolute", () => {
    const r = parsePipelineYaml(`
version: 1
artifacts: ["a.jar"]
runtime:
  image: alpine
  copy:
    - from: a.jar
      to: relative/path
  command: ["sh"]
`);
    expect(r.ok).toBe(false);
  });

  it("returns a structured failure for malformed YAML", () => {
    const r = parsePipelineYaml(":\n:\n  - [\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/invalid YAML/i);
  });

  it("allows pipelines with no build (artifact-only / wrap-an-image pattern)", () => {
    const r = parsePipelineYaml(`
version: 1
runtime:
  image: nginx:alpine
  command: ["nginx", "-g", "daemon off;"]
ports:
  - port: 80
`);
    expect(r.ok).toBe(true);
  });
});
