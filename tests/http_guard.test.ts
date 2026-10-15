import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AddressInfo } from "node:net";

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
        const { server } = await createDaemonServer({ port: 0, version: "test", maxBodyBytes: MAX_BODY });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        port = (server.address() as AddressInfo).port;
        close = () => new Promise((resolve) => server.close(() => resolve()));
    });
    afterEach(async () => { await close(); closeDatabase(); });

    const call = { tool: "send_message", args: { message: "x" }, instanceId: "t" };

    it("rejects requests that carry a browser Origin header", async () => {
        const res = await requestJson<{ error: string }>(port, "POST", "/api/tools/call", call, { Origin: "https://evil.example" });
        expect(res.status).toBe(403);
        const get = await requestJson(port, "GET", "/api/tools", undefined, { "Sec-Fetch-Site": "cross-site" });
        expect(get.status).toBe(403);
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

    it("still serves plain JSON clients", async () => {
        const res = await requestJson<{ ok: boolean }>(port, "POST", "/api/tools/call", call);
        expect(res.status).toBe(200);
        expect(res.payload.ok).toBe(true);
    });
});
