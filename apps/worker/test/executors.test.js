import { afterEach, describe, expect, it, vi } from "vitest";
import { executors } from "../src/executors.js";
describe("CLI executors", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });
    it("uses simulated output when SM_EXECUTOR_SIMULATE=1", async () => {
        vi.stubEnv("SM_EXECUTOR_SIMULATE", "1");
        vi.stubEnv("SM_CURSOR_BIN", "cursor");
        const r = await executors.cursor.run({
            workspacePath: "/tmp/ws",
            prompt: "hello world",
            env: {}
        });
        expect(r.metadata.simulated).toBe(true);
        expect(r.exitCode).toBe(0);
        expect(r.log).toContain("[cursor] simulated run in /tmp/ws:");
        expect(r.log).toContain("hello world".slice(0, 64));
        expect(r.metadata.command).toEqual(["cursor"]);
        expect(r.metadata.startedAt <= r.metadata.endedAt).toBe(true);
    });
    it("falls back to simulated output when the binary is not available", async () => {
        vi.stubEnv("SM_CLAUDE_BIN", "/nonexistent/path/claude-sm-test-missing-bin");
        const r = await executors.claude.run({
            workspacePath: "/tmp/ws2",
            prompt: "prompt",
            env: {}
        });
        expect(r.metadata.simulated).toBe(true);
        expect(r.exitCode).toBe(0);
        expect(r.log).toContain("[claude] simulated run");
        expect(r.metadata.command).toEqual(["/nonexistent/path/claude-sm-test-missing-bin"]);
    });
});
//# sourceMappingURL=executors.test.js.map