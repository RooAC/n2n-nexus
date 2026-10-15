import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { RateLimiter, rateLimitFromEnv } from "../src/daemon/rate-limit.js";
import { createDaemonServer } from "../src/daemon/server.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import { StorageManager } from "../src/storage/index.js";
import { NexusServer } from "../src/server/nexus.js";
import { requestJson } from "./helpers/daemon.js";

describe("RateLimiter", () => {
    it("allows a burst, then refills at the configured rate", () => {
        let t = 0;
        const limiter = new RateLimiter(2, 3, () => t);
        expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([0, 0, 0]);
        expect(limiter.take("a")).toBe(1);          // empty: next token in 0.5 s, reported as 1 s
        expect(limiter.take("b")).toBe(0);          // other keys are independent
        t += 500;
        expect(limiter.take("a")).toBe(0);
        expect(limiter.take("a")).toBeGreaterThan(0);
    });

    it("is disabled with a limit of 0 and reads its defaults from the environment", () => {
        // burst below one call still allows one call per refill instead of rejecting forever,
        // and burst 0 does not silently disable limiting.
        let t = 0;
        const tiny = new RateLimiter(1, 0.5, () => t);
        expect(tiny.enabled).toBe(true);
        expect(tiny.take("k")).toBe(0);
        expect(tiny.take("k")).toBe(1);
        t += 1000;
        expect(tiny.take("k")).toBe(0);
        expect(new RateLimiter(5, 0).enabled).toBe(true);

        const off = new RateLimiter(0, 0);
        for (let i = 0; i < 1000; i++) expect(off.take("x")).toBe(0);
        expect(rateLimitFromEnv({})).toEqual({ perSecond: 20, burst: 60 });
        expect(rateLimitFromEnv({ NEXUS_RATE_LIMIT: "0" }).perSecond).toBe(0);
        expect(rateLimitFromEnv({ NEXUS_RATE_LIMIT: "5", NEXUS_RATE_BURST: "10" })).toEqual({ perSecond: 5, burst: 10 });
        expect(rateLimitFromEnv({ NEXUS_RATE_LIMIT: "abc" }).perSecond).toBe(20);
    });
});

describe("Daemon rate limiting", () => {
    const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "rate-limit");
    let port: number;
    let close: () => Promise<void>;

    beforeEach(async () => {
        closeDatabase();
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        StorageManager.resetInit();
        // Burst 3 per instance, 15 per address (5x). The refill rate is so low that no
        // token comes back during a test, so the counts do not depend on machine speed.
        const { server } = await createDaemonServer({ port: 0, version: "test", rateLimit: { perSecond: 0.001, burst: 3 } });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as AddressInfo).port;
        close = () => new Promise((r) => server.close(() => r()));
    });
    afterEach(async () => { await close(); closeDatabase(); });

    const send = (instanceId: string) => requestJson<{ ok: boolean; error?: string }>(port, "POST", "/api/tools/call",
        { tool: "send_message", args: { message: "x" }, instanceId });

    it("answers 429 with Retry-After once an instance spends its burst, without affecting others", async () => {
        for (let i = 0; i < 3; i++) expect((await send("busy")).status).toBe(200);
        const limited = await send("busy");
        expect(limited.status).toBe(429);
        expect(limited.payload.error).toContain("instance 'busy'");
        expect((await send("calm")).status).toBe(200);
        // Health and the tool list are never limited.
        for (let i = 0; i < 20; i++) expect((await requestJson(port, "GET", "/api/tools")).status).toBe(200);
    });

    it("limits requests without an instance id only per address, not in a shared bucket", async () => {
        for (let i = 0; i < 10; i++) {
            const res = await requestJson<{ error?: string }>(port, "GET", "/api/meetings");
            expect(res.status, `request ${i}: ${res.payload.error}`).toBe(200);
        }
    });

    it("caps a client that rotates instance ids by its address", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 20; i++) statuses.push((await send(`rotating-${i}`)).status);
        expect(statuses.slice(0, 15).every((s) => s === 200)).toBe(true);
        expect(statuses.slice(15).every((s) => s === 429)).toBe(true);
    });

    it("reaches the MCP client as a tool error, not as a lost daemon", async () => {
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${port}`;
        process.env.NEXUS_INSTANCE_ID = "mcp-busy";
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await new NexusServer().run({ transport: serverSide });
        const client = new Client({ name: "ide", version: "1" });
        await client.connect(clientSide);
        const before = (await client.listTools()).tools.length;

        let last;
        for (let i = 0; i < 4; i++) last = await client.callTool({ name: "send_message", arguments: { message: "m" } });
        expect(last!.isError).toBe(true);
        expect(JSON.stringify(last!.content)).toContain("Rate limit exceeded");
        expect((await client.listTools()).tools.length).toBe(before);
        await client.close();
    });
});
