// Host / browser-origin guard, Content-Type, body limit and body shape (contract/errors.json).
import http from "node:http";
import { describe, expect, it } from "vitest";
import { ERRORS, RawBody, useHost } from "./harness.js";

const MAX_BODY = ERRORS.maxBodyBytes;
const host = useHost({ allowedHosts: ["nexus.lan"] });
const call = { tool: "send_message", args: { message: "x" }, instanceId: "t" };

/** POST /api/tools/call declaring or streaming `bytes` of body; resolves with the response, then drops the connection. */
function oversized(mode: "declared" | "chunked", bytes: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { "Content-Type": "application/json", ...(mode === "declared" ? { "Content-Length": String(bytes) } : { "Transfer-Encoding": "chunked" }) };
        const req = http.request({ method: "POST", hostname: "127.0.0.1", port: host.port, path: "/api/tools/call", agent: false, headers }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => (body += c));
            res.on("end", () => { resolve({ status: res.statusCode ?? 0, body }); req.destroy(); });
        });
        req.on("error", reject);
        const head = "{\"tool\":\"send_message\",\"args\":{\"message\":\"";
        req.write(head);
        if (mode === "declared") return;                                        // the host must answer before the body arrives
        const chunk = "x".repeat(1024 * 1024);
        let left = bytes - head.length;
        while (left > 0) {
            req.write(left >= chunk.length ? chunk : chunk.slice(0, left));
            left -= chunk.length;
        }
        req.end("\"}}");
    });
}

describe("HTTP guards", () => {
    it.each(["[", "localhost:bad", "[::1]:65536"])("rejects malformed Host %s with 400 and continues serving", async (name) => {
        const res = await host.request<{ error: string }>("GET", "/health", undefined, { Host: name });
        expect(res.status).toBe(400);
        expect((await host.request("GET", "/health")).status).toBe(200);
    });

    it.each(["http://[", "//["])("rejects malformed request target %s with 400 and continues serving", async (target) => {
        const res = await host.request("GET", target);
        expect(res.status).toBe(400);
        expect((await host.request("GET", "/health")).status).toBe(200);
    });

    it("rejects a request without a Host header with 400", async () => {
        const raw = await host.raw("GET /health HTTP/1.0\r\n\r\n");
        expect(raw).toMatch(/^HTTP\/1\.[01] 400 /);
    });

    it("rejects requests that carry a browser Origin header or a cross-site Sec-Fetch-Site", async () => {
        const res = await host.request<{ ok: boolean; error: string }>("POST", "/api/tools/call", call, { Origin: "https://evil.example" });
        expect(res.status).toBe(403);
        expect(res.payload).toEqual({ ok: false, error: expect.any(String) });
        const get = await host.request("GET", "/api/tools", undefined, { "Sec-Fetch-Site": "cross-site" });
        expect(get.status).toBe(403);
    });

    it("rejects DNS-rebinding style Host names but accepts IPs, localhost and configured names", async () => {
        const rebind = await host.request<{ error: string }>("GET", "/api/tools", undefined, { Host: "evil.example:5688", "Sec-Fetch-Site": "same-origin" });
        expect(rebind.status).toBe(403);
        expect(rebind.payload.error).toContain("allowedHosts");

        for (const name of ["127.0.0.1:1", "localhost:5688", "[::1]:5688", "192.168.1.20:5688", "host.docker.internal:5688", "nexus.lan:5688"]) {
            const ok = await host.request("GET", "/api/tools", undefined, { Host: name });
            expect(ok.status, name).toBe(200);
        }
    });

    it("rejects POST bodies that are not application/json", async () => {
        const res = await host.request<{ ok: boolean }>("POST", "/api/tools/call", call, { "Content-Type": "text/plain" });
        expect(res.status).toBe(415);
        expect(res.payload.ok).toBe(false);
    });

    it("answers 413 for a declared body above the size limit", async () => {
        const res = await oversized("declared", MAX_BODY + 1);
        expect(res.status).toBe(413);
        expect(JSON.parse(res.body).error).toContain("exceeds");
    });

    it("answers 413 for an oversized chunked body too", async () => {
        const res = await oversized("chunked", MAX_BODY + 64 * 1024);
        expect(res.status).toBe(413);
        expect(JSON.parse(res.body).error).toContain("exceeds");
    });

    it("answers 400, not 500, for a body that is not a JSON object or not JSON", async () => {
        for (const body of [null, [], "text", 42]) {
            const res = await host.request<{ error: string }>("POST", "/api/tools/call", body);
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(res.payload.error).toContain("JSON object");
        }
        const invalid = await host.request<{ ok: boolean }>("POST", "/api/tools/call", new RawBody("{not json"));
        expect(invalid.status).toBe(400);
        expect(invalid.payload.ok).toBe(false);
    });

    it("still serves plain JSON clients", async () => {
        const res = await host.request<{ ok: boolean }>("POST", "/api/tools/call", call);
        expect(res.status).toBe(200);
        expect(res.payload.ok).toBe(true);
    });
});
