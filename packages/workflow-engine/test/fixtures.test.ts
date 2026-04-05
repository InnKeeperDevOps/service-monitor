import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { topologicalWaves } from "../src/index.js";
import type { WorkflowEdge, WorkflowNode } from "@sm/domain";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/contracts/fixtures/workflows"
);

interface WorkflowFixture {
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  expectedWaves: string[][];
  notes: string;
}

function loadFixture(filename: string): WorkflowFixture {
  const raw = fs.readFileSync(path.join(fixturesDir, filename), "utf-8");
  return JSON.parse(raw) as WorkflowFixture;
}

const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("golden DAG fixtures", () => {
  it.each(fixtureFiles)("%s — topologicalWaves matches expectedWaves", (filename) => {
    const fixture = loadFixture(filename);
    const waves = topologicalWaves(fixture.nodes, fixture.edges);

    expect(waves.length).toBe(fixture.expectedWaves.length);

    for (let i = 0; i < waves.length; i++) {
      expect(waves[i].slice().sort()).toEqual(fixture.expectedWaves[i].slice().sort());
    }
  });
});
