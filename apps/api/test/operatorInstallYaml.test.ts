import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import {
  buildOperatorInstallYaml,
  defaultOperatorInstallOptions,
  parseOperatorInstallOptions
} from "../src/operatorInstallYaml.js";

const app = buildServer();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("buildOperatorInstallYaml", () => {
  it("contains every manifest the operator needs", () => {
    const yaml = buildOperatorInstallYaml(defaultOperatorInstallOptions());
    expect(yaml).toContain("kind: CustomResourceDefinition");
    expect(yaml).toContain("name: kaiadagents.kaiad.dev");
    expect(yaml).toContain("kind: Namespace");
    expect(yaml).toContain("kind: ServiceAccount");
    expect(yaml).toContain("kind: ClusterRole");
    expect(yaml).toContain("kind: ClusterRoleBinding");
    expect(yaml).toContain("kind: Deployment");
  });

  it("threads namespace + image into the rendered manifests", () => {
    const yaml = buildOperatorInstallYaml({
      namespace: "kaiad-prod",
      image: "registry.example.com/kaiad-operator:1.2.3"
    });
    expect(yaml).toContain("namespace: kaiad-prod");
    expect(yaml).toContain("image: registry.example.com/kaiad-operator:1.2.3");
  });
});

describe("parseOperatorInstallOptions", () => {
  it("returns defaults for empty query", () => {
    const r = parseOperatorInstallOptions({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.namespace).toBe("kaiad-system");
      expect(r.value.image.startsWith("ghcr.io/innkeeperdevops/kaiad-operator:")).toBe(true);
    }
  });

  it("rejects an invalid namespace", () => {
    const r = parseOperatorInstallOptions({ namespace: "Bad Namespace" });
    expect(r.ok).toBe(false);
  });

  it("rejects an image with whitespace", () => {
    const r = parseOperatorInstallOptions({ image: "bad image:tag" });
    expect(r.ok).toBe(false);
  });
});

describe("GET /api/v1/operator/install.yaml", () => {
  it("serves the install bundle as a YAML download", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operator/install.yaml"
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/yaml/);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="kaiad-operator-install.yaml"'
    );
    expect(response.body).toContain("kind: CustomResourceDefinition");
    expect(response.body).toContain("kind: Deployment");
  });

  it("honors namespace and image query params", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operator/install.yaml?namespace=kaiad-prod&image=registry.example.com/kaiad-operator:1.2.3"
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("namespace: kaiad-prod");
    expect(response.body).toContain("image: registry.example.com/kaiad-operator:1.2.3");
  });

  it("rejects an invalid namespace with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operator/install.yaml?namespace=Bad_Namespace"
    });
    expect(response.statusCode).toBe(400);
  });
});
