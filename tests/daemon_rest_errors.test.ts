import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";

describe("REST path parameters", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("daemon-rest-errors"); });
    afterEach(async () => { vi.restoreAllMocks(); await daemon.close(); });

    it("rejects malformed percent-encoding with 400, not a daemon error", async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => { });
        for (const route of ["/api/projects/%E0", "/api/global/docs/%E0", "/api/meetings/%E0", "/api/tasks/%E0"]) {
            const res = await daemon.request<{ ok: boolean; error: string }>("GET", route);
            expect(res.status, route).toBe(400);
            expect(res.payload.ok).toBe(false);
        }
        expect(errors).not.toHaveBeenCalled();
    });

    it("rejects an unsafe document id with 400, as the tool call does", async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => { });
        const tool = await daemon.callTool("get_global_doc", { docId: "a/b" });
        expect(tool.status).toBe(400);
        const rest = await daemon.request<{ ok: boolean; error: string }>("GET", "/api/global/docs/a%2Fb");
        expect(rest.status).toBe(400);
        expect(rest.payload.ok).toBe(false);
        expect(errors).not.toHaveBeenCalled();
    });
});
