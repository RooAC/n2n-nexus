import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AddressInfo } from "node:net";
import http from "node:http";

import { createDaemonServer } from "../src/daemon/server.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import { StorageManager } from "../src/storage/index.js";
import { requestJson } from "./helpers/daemon.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "http-guard");
const MAX_BODY = 1024;

describe("Daemon HTTP guards", () => {
    let port: number;
    let close: () => Promise<void>;

    beforeEach(async () => {
        closeDatabase();
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        StorageManager.resetInit();
        const { server } = await createDaemonServer({ port: 0, version: "test", maxBodyBytes: MAX_BODY, allowedHosts: ["localhost", "host.docker.internal", "nexus.lan"] });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        port = (server.address() as AddressInfo).port;
        close = () => new Promise((resolve) => server.close(() => resolve()));
    });
    afterEach(async () => { await close(); closeDatabase(); });

    const call = { tool: "send_message", args: { message: "x" }, instanceId: "t" };

    it.each(["[", "localhost:bad", "[::1]:65536"])("rejects malformed Host %s and continues serving", async (host) => {
        const res = await requestJson<{ error: string }>(port, "GET", "/health", undefined, { Host: host });
        expect(res.status).toBe(400);
        expect(res.payload.error).toContain("Invalid request URL or Host header");
        expect((await requestJson(port, "GET", "/health")).status).toBe(200);
    });

    it.each(["http://[", "//["])("rejects malformed request target %s and continues serving", async (target) => {
        const res = await requestJson(port, "GET", target);
        expect(res.status).toBe(400);
        expect((await requestJson(port, "GET", "/health")).status).toBe(200);
    });

    it("preserves query parameters for valid requests", async () => {
        await requestJson(port, "POST", "/api/tools/call", call);
        await requestJson(port, "POST", "/api/tools/call", call);
        const res = await requestJson<{ count: number }>(port, "GET", "/api/messages/unread?count=1&instanceId=reader");
        expect(res.status).toBe(200);
        expect(res.payload.count).toBe(1);
    });

    it("rejects requests that carry a browser Origin header", async () => {
        const res = await requestJson<{ error: string }>(port, "POST", "/api/tools/call", call, { Origin: "https://evil.example" });
        expect(res.status).toBe(403);
        const get = await requestJson(port, "GET", "/api/tools", undefined, { "Sec-Fetch-Site": "cross-site" });
        expect(get.status).toBe(403);
    });

    it("rejects DNS-rebinding style Host names but accepts IPs, localhost and configured names", async () => {
        const rebind = await requestJson<{ error: string }>(port, "GET", "/api/tools", undefined, { Host: "evil.example:5688", "Sec-Fetch-Site": "same-origin" });
        expect(rebind.status).toBe(403);
        expect(rebind.payload.error).toContain("NEXUS_ALLOWED_HOSTS");

        for (const host of ["127.0.0.1:1", "localhost:5688", "[::1]:5688", "192.168.1.20:5688", "host.docker.internal:5688", "nexus.lan:5688"]) {
            const ok = await requestJson(port, "GET", "/api/tools", undefined, { Host: host });
            expect(ok.status, host).toBe(200);
        }
    });

    it("rejects POST bodies that are not application/json", async () => {
        const res = await requestJson<{ error: string }>(port, "POST", "/api/tools/call", call, { "Content-Type": "text/plain" });
        expect(res.status).toBe(415);
    });

    it("rejects bodies above the size limit", async () => {
        const big = { ...call, args: { message: "x".repeat(MAX_BODY * 2) } };
        const res = await requestJson<{ error: string }>(port, "POST", "/api/tools/call", big);
        expect(res.status).toBe(413);
    });

    it("answers 413 for an oversized chunked body too", async () => {
        const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = http.request(
                { method: "POST", hostname: "127.0.0.1", port, path: "/api/tools/call",
                  headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" } },
                (r) => { let body = ""; r.on("data", (c) => (body += c)); r.on("end", () => resolve({ status: r.statusCode || 0, body })); }
            );
            req.on("error", reject);
            req.write("{\"tool\":\"send_message\",\"args\":{\"message\":\"");
            req.write("x".repeat(MAX_BODY * 2));
            req.end("\"}}");
        });
        expect(res.status).toBe(413);
        expect(JSON.parse(res.body).error).toContain("exceeds");
    });

    it("answers 400, not 500, for a body that is not a JSON object", async () => {
        for (const body of [null, [], "text", 42]) {
            const res = await requestJson<{ error: string }>(port, "POST", "/api/tools/call", body);
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(res.payload.error).toContain("JSON object");
        }
    });

    it("still serves plain JSON clients", async () => {
        const res = await requestJson<{ ok: boolean }>(port, "POST", "/api/tools/call", call);
        expect(res.status).toBe(200);
        expect(res.payload.ok).toBe(true);
    });
});
