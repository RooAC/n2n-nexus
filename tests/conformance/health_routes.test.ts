import { describe, expect, it } from "vitest";
import { HOOK, useHost } from "./harness.js";

describe("GET /health and routing", () => {
    const host = useHost();

    it("answers health with ok and the host version", async () => {
        const res = await host.request<{ ok: boolean; version: string }>("GET", "/health");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("application/json");
        expect(res.payload.ok).toBe(true);
        expect(typeof res.payload.version).toBe("string");
    });

    it("names the service and the contract version in health", async () => {
        const res = await host.request<Record<string, unknown>>("GET", "/health");
        expect(res.payload).toEqual({ ok: true, service: "n2n-nexus", version: expect.any(String), contractVersion: HOOK.contractVersion });
    });

    it("answers unknown routes with a 404 error body", async () => {
        for (const [method, route] of [["GET", "/nope"], ["POST", "/api/nope"], ["GET", "/api/tools/call"], ["POST", "/health"]] as const) {
            const res = await host.request<{ ok: boolean; error: string }>(method, route, method === "POST" ? {} : undefined);
            expect(res.status, `${method} ${route}`).toBe(404);
            expect(res.payload).toEqual({ ok: false, error: expect.any(String) });
        }
    });

    it("no longer serves the removed REST endpoints", async () => {
        const removed: [string, string][] = [
            ["GET", "/api/projects/search?query=x"], ["POST", "/api/projects/sync"], ["GET", "/api/projects/topology"],
            ["GET", "/api/messages/unread?instanceId=r"], ["POST", "/api/messages/send"],
            ["GET", "/api/global/docs"], ["GET", "/api/global/strategy"], ["GET", "/api/meetings"], ["POST", "/api/meetings/start"],
            ["GET", "/api/tasks"], ["POST", "/api/tasks"], ["POST", "/api/tasks/x/update"], ["GET", "/api/events"], ["POST", "/api/maintenance/logs"]
        ];
        for (const [method, route] of removed) {
            const res = await host.request<{ ok: boolean }>(method, route, method === "POST" ? { instanceId: "r" } : undefined);
            expect(res.status, `${method} ${route}`).toBe(404);
            expect(res.payload.ok).toBe(false);
        }
    });
});
