import { describe, expect, it } from "vitest";
import { parsePipelineYaml, resolveEnvironment, selectPipeline } from "../src/pipeline.js";

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

  describe("instances + domains + environments", () => {
    const base = `
version: 1
runtime:
  image: nginx:alpine
  command: ["nginx", "-g", "daemon off;"]
ports:
  - port: 80
    name: http
  - port: 9090
    name: metrics
`;

    it("defaults instances to 1 and domains/environments to empty", () => {
      const r = parsePipelineYaml(base);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pipeline.instances).toBe(1);
      expect(r.pipeline.domains).toEqual([]);
      expect(r.pipeline.environments).toEqual({});
    });

    it("accepts top-level instances + domains and per-env overrides", () => {
      const r = parsePipelineYaml(`${base}
instances: 1
domains:
  - host: dev.example.com
    port: 80
    protocol: https
environments:
  staging:
    instances: 2
    domains:
      - host: staging.example.com
        port: 80
        protocol: https
  production:
    instances: 3
    domains:
      - host: example.com
        port: 80
        protocol: https
      - host: metrics.example.com
        port: 9090
        protocol: https
`);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pipeline.environments.staging?.instances).toBe(2);
      expect(r.pipeline.environments.production?.domains).toHaveLength(2);
    });

    it("rejects domain.port that is not in ports[]", () => {
      const r = parsePipelineYaml(`${base}
domains:
  - host: oops.example.com
    port: 8080
    protocol: https
`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/8080.*ports/i);
    });

    it("rejects environments[*].domains[*].port that is not in ports[]", () => {
      const r = parsePipelineYaml(`${base}
environments:
  production:
    domains:
      - host: oops.example.com
        port: 8080
        protocol: https
`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/8080.*ports/i);
    });

    it("rejects environment names that aren't k8s-style", () => {
      const r = parsePipelineYaml(`${base}
environments:
  PROD:
    instances: 1
`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/lowercase alphanumeric/);
    });

    it("rejects domains when ports[] is empty", () => {
      const r = parsePipelineYaml(`
version: 1
runtime:
  image: alpine
  command: ["sh"]
domains:
  - host: nowhere.example.com
    port: 80
    protocol: https
`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/ports\[\]/);
    });

    it("rejects malformed hostnames", () => {
      const r = parsePipelineYaml(`${base}
domains:
  - host: "has spaces.example.com"
    port: 80
    protocol: https
`);
      expect(r.ok).toBe(false);
    });

    it("loadBalancer defaults to type=none", () => {
      const r = parsePipelineYaml(base);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pipeline.loadBalancer).toEqual({ type: "none" });
    });

    it("accepts each loadBalancer type with its optional fields", () => {
      const r = parsePipelineYaml(`${base}
loadBalancer:
  type: k8s
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: nlb
environments:
  staging:
    loadBalancer:
      type: metallb
      addressPool: staging-pool
  production:
    loadBalancer:
      type: nginx
      ingressClass: nginx-prod
      tlsSecret: prod-tls
`);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pipeline.loadBalancer.type).toBe("k8s");
      expect(r.pipeline.environments.staging?.loadBalancer).toEqual({
        type: "metallb",
        addressPool: "staging-pool"
      });
      expect(r.pipeline.environments.production?.loadBalancer).toEqual({
        type: "nginx",
        ingressClass: "nginx-prod",
        tlsSecret: "prod-tls"
      });
    });

    it("rejects unknown loadBalancer type", () => {
      const r = parsePipelineYaml(`${base}
loadBalancer:
  type: traefik
`);
      expect(r.ok).toBe(false);
    });

    it("nginx loadBalancer fills in ingressClass default", () => {
      const r = parsePipelineYaml(`${base}
loadBalancer:
  type: nginx
`);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const lb = r.pipeline.loadBalancer;
      // narrow before reading
      if (lb.type !== "nginx") throw new Error("expected nginx");
      expect(lb.ingressClass).toBe("nginx");
    });

    it("resolveEnvironment includes loadBalancer with overlay precedence", () => {
      const r = parsePipelineYaml(`${base}
loadBalancer:
  type: k8s
environments:
  staging:
    instances: 2
  production:
    loadBalancer:
      type: metallb
      addressPool: prod
`);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // staging inherits the default LB
      const staging = resolveEnvironment(r.pipeline, "staging");
      expect(staging.loadBalancer.type).toBe("k8s");

      // production overrides
      const prod = resolveEnvironment(r.pipeline, "production");
      expect(prod.loadBalancer).toEqual({ type: "metallb", addressPool: "prod" });

      // unknown env -> all defaults
      const unknown = resolveEnvironment(r.pipeline, "preview");
      expect(unknown.loadBalancer.type).toBe("k8s");
    });

    it("resolveEnvironment overlays per-env over defaults", () => {
      const r = parsePipelineYaml(`${base}
instances: 1
domains:
  - host: default.example.com
    port: 80
    protocol: https
environments:
  staging:
    instances: 2
  production:
    domains:
      - host: prod.example.com
        port: 80
        protocol: https
`);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // staging overrides instances but not domains -> falls back to default domains
      const staging = resolveEnvironment(r.pipeline, "staging");
      expect(staging.instances).toBe(2);
      expect(staging.domains[0]?.host).toBe("default.example.com");

      // production overrides domains but not instances -> falls back to default instances
      const prod = resolveEnvironment(r.pipeline, "production");
      expect(prod.instances).toBe(1);
      expect(prod.domains[0]?.host).toBe("prod.example.com");

      // unknown env -> all defaults
      const unknown = resolveEnvironment(r.pipeline, "preview");
      expect(unknown.instances).toBe(1);
      expect(unknown.domains[0]?.host).toBe("default.example.com");
    });
  });

  describe("multi-service kaiad.yaml", () => {
    const multi = `
version: 1
services:
  php:
    build:
      image: php:8-cli
      steps: ["composer install"]
    artifacts: ["app.tar"]
    runtime:
      image: php:8-fpm
      layers: ["app.tar"]
      command: ["php-fpm"]
    ports:
      - port: 9000
  nginx:
    build:
      image: alpine
      steps: ["echo build"]
    artifacts: ["site.tar"]
    runtime:
      image: nginx:alpine
      layers: ["site.tar"]
      command: ["nginx", "-g", "daemon off;"]
    ports:
      - port: 80
`;

    it("parses a multi-pipeline file", () => {
      const r = parsePipelineYaml(multi);
      expect(r.ok).toBe(true);
      if (!r.ok || r.kind !== "multi") return;
      expect(Object.keys(r.pipelines).sort()).toEqual(["nginx", "php"]);
      expect(r.pipelines.php.runtime?.command).toEqual(["php-fpm"]);
    });

    it("rejects multi-pipeline with bad pipeline-name shape", () => {
      const r = parsePipelineYaml(`
version: 1
services:
  PHP:   # uppercase rejected
    build: { image: a, steps: [b] }
`);
      expect(r.ok).toBe(false);
    });

    it("rejects empty services map", () => {
      const r = parsePipelineYaml(`version: 1\nservices: {}\n`);
      expect(r.ok).toBe(false);
    });

    it("selectPipeline picks by name from a multi", () => {
      const r = parsePipelineYaml(multi);
      const picked = selectPipeline(r, "php");
      expect(picked.ok).toBe(true);
      if (!picked.ok) return;
      expect(picked.pipeline.runtime?.command).toEqual(["php-fpm"]);
    });

    it("selectPipeline complains when multi but no name given", () => {
      const r = parsePipelineYaml(multi);
      const picked = selectPipeline(r, null);
      expect(picked.ok).toBe(false);
      if (picked.ok) return;
      expect(picked.reason).toMatch(/multi-pipeline/);
    });

    it("selectPipeline complains when name missing from services map", () => {
      const r = parsePipelineYaml(multi);
      const picked = selectPipeline(r, "missing");
      expect(picked.ok).toBe(false);
    });

    it("selectPipeline on single returns the lone pipeline", () => {
      const r = parsePipelineYaml(`
version: 1
build: { image: alpine, steps: [echo] }
artifacts: []
runtime: { image: alpine, command: [sh] }
`);
      const picked = selectPipeline(r, null);
      expect(picked.ok).toBe(true);
      if (!picked.ok) return;
      expect(picked.pipeline.runtime?.command).toEqual(["sh"]);
    });

    it("selectPipeline on single rejects a stray pipelineName", () => {
      const r = parsePipelineYaml(`
version: 1
build: { image: alpine, steps: [echo] }
artifacts: []
runtime: { image: alpine, command: [sh] }
`);
      const picked = selectPipeline(r, "php");
      expect(picked.ok).toBe(false);
    });
  });

  describe("dockerfile mode", () => {
    it("accepts a minimal dockerfile pipeline", () => {
      const r = parsePipelineYaml(`
version: 1
dockerfile:
  path: Dockerfile
ports:
  - port: 9000
`);
      expect(r.ok).toBe(true);
      if (!r.ok || r.kind !== "single") return;
      expect(r.pipeline.dockerfile?.path).toBe("Dockerfile");
      expect(r.pipeline.dockerfile?.context).toBe(".");
    });

    it("fills defaults for path + context + args", () => {
      const r = parsePipelineYaml(`
version: 1
dockerfile: {}
`);
      expect(r.ok).toBe(true);
      if (!r.ok || r.kind !== "single") return;
      expect(r.pipeline.dockerfile?.path).toBe("Dockerfile");
      expect(r.pipeline.dockerfile?.context).toBe(".");
      expect(r.pipeline.dockerfile?.args).toEqual({});
    });

    it("rejects dockerfile alongside build", () => {
      const r = parsePipelineYaml(`
version: 1
dockerfile: {}
build:
  image: alpine
  steps: [echo]
`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/exclusive/);
    });

    it("rejects dockerfile alongside runtime", () => {
      const r = parsePipelineYaml(`
version: 1
dockerfile: {}
runtime:
  image: alpine
  command: ["sh"]
`);
      expect(r.ok).toBe(false);
    });

    it("rejects dockerfile alongside non-empty artifacts", () => {
      const r = parsePipelineYaml(`
version: 1
dockerfile: {}
artifacts: ["foo.tar"]
`);
      expect(r.ok).toBe(false);
    });

    it("dockerfile mode works inside multi-pipeline file", () => {
      const r = parsePipelineYaml(`
version: 1
services:
  base:
    dockerfile:
      path: deploy/Dockerfile
      args:
        PHP_VERSION: "8.2"
      target: runtime
    ports: [{ port: 9000 }]
`);
      expect(r.ok).toBe(true);
      if (!r.ok || r.kind !== "multi") return;
      expect(r.pipelines.base.dockerfile?.path).toBe("deploy/Dockerfile");
      expect(r.pipelines.base.dockerfile?.args).toEqual({ PHP_VERSION: "8.2" });
      expect(r.pipelines.base.dockerfile?.target).toBe("runtime");
    });
  });

  describe("runtime.layers", () => {
    it("accepts layers when present in artifacts[]", () => {
      const r = parsePipelineYaml(`
version: 1
artifacts: ["rootfs.tar"]
runtime:
  image: alpine
  layers: ["rootfs.tar"]
  command: ["sh"]
`);
      expect(r.ok).toBe(true);
    });

    it("rejects layers entry not in artifacts[]", () => {
      const r = parsePipelineYaml(`
version: 1
artifacts: ["a.tar"]
runtime:
  image: alpine
  layers: ["b.tar"]
  command: ["sh"]
`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/layers.*b\.tar/);
    });
  });
});
