import { describe, expect, it } from "vitest";
import os from "node:os";
import { resolveInstanceId } from "../src/server/instance-id.js";

describe("resolveInstanceId", () => {
    it("prefers the environment variable, then --id", () => {
        expect(resolveInstanceId({ NEXUS_INSTANCE_ID: "env-id" }, ["node", "x", "--id", "arg-id"], "/w")).toBe("env-id");
        expect(resolveInstanceId({}, ["node", "x", "--id", "arg-id"], "/w")).toBe("arg-id");
    });

    it("derives a stable id from hostname and working directory", () => {
        const a = resolveInstanceId({}, ["node", "x"], "/workspace/one");
        const b = resolveInstanceId({}, ["node", "x"], "/workspace/one");
        const c = resolveInstanceId({}, ["node", "x"], "/workspace/two");
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a.startsWith(`mcp-${os.hostname()}-`)).toBe(true);
    });
});
