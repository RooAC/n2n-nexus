import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

const autostart = vi.hoisted(() => ({ calls: [] as string[], start: undefined as undefined | ((endpoint: string) => Promise<boolean>) }));
vi.mock("../src/cli/autostart.js", () => ({
    startLocalDaemon: async (endpoint: string) => { autostart.calls.push(endpoint); return autostart.start ? autostart.start(endpoint) : false; }
}));

import { NexusServer } from "../src/server/nexus.js";

type Recorded = { url: string; body: Record<string, unknown> };
const proxies: NexusServer[] = [];
const clients: Client[] = [];
const servers: http.Server[] = [];

beforeEach(() => {
    autostart.calls.length = 0;
    autostart.start = undefined;
    process.env.NEXUS_INSTANCE_ID = "identity-test";
});

afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(proxies.splice(0).map((proxy) => proxy.shutdown()));
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** Daemon stand-in that records every request and echoes tool calls back. */
async function fakeDaemon(port = 0) {
    const requests: Recorded[] = [];
    const server = http.createServer((req, res) => {
        let data = "";
        req.on("data", (chunk) => { data += chunk; });
        req.on("end", () => {
            const body = data ? JSON.parse(data) as Record<string, unknown> : {};
            requests.push({ url: req.url!, body });
            if (req.url === "/api/tools") {
                res.end(JSON.stringify({ tools: [{ name: "echo", description: "Echo request", inputSchema: { type: "object", properties: {} } }] }));
            } else {
                res.end(JSON.stringify({ ok: true, result: body }));
            }
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return requests;
}

async function connect(clientName: string, stateless: boolean) {
    const proxy = new NexusServer();
    proxies.push(proxy);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.run({ transport: serverSide });
    const client = new Client({ name: clientName, version: "1" }, stateless ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
    clients.push(client);
    await client.connect(clientSide);
    return client;
}

async function callEcho(client: Client, meta: Record<string, unknown>, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name: "echo", arguments: args, _meta: meta });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return result.structuredContent as Record<string, unknown>;
}

for (const stateless of [false, true]) {
    describe(`Caller identity, ${stateless ? "2026-07-28" : "2025-11-25"} protocol`, () => {
        it("names a Claude Code caller by the toolUseId in _meta, outside model arguments", async () => {
            await fakeDaemon();
            const client = await connect("claude-code", stateless);
            const forwarded = await callEcho(client, { "claudecode/toolUseId": "toolu_1" },
                { caller: { client: "codex", sessionId: "spoofed" } });
            expect(forwarded.caller).toEqual({ client: "claude", toolUseId: "toolu_1" });
            expect(forwarded.args).toEqual({ caller: { client: "codex", sessionId: "spoofed" } });
        });

        it("names a Codex caller by the sessionId in _meta, so each conversation is distinct", async () => {
            await fakeDaemon();
            const client = await connect("codex-mcp-client", stateless);
            expect((await callEcho(client, { sessionId: "thread-a", threadId: "thread-a" })).caller)
                .toEqual({ client: "codex", sessionId: "thread-a" });
            expect((await callEcho(client, { sessionId: "thread-b", threadId: "sub-agent" })).caller)
                .toEqual({ client: "codex", sessionId: "thread-b" });
        });

        it("sends no caller for other clients or when the identifying _meta is missing", async () => {
            await fakeDaemon();
            const other = await connect("Cursor", stateless);
            expect(await callEcho(other, { sessionId: "x", "claudecode/toolUseId": "y" })).not.toHaveProperty("caller");
            const claude = await connect("claude-code", stateless);
            expect(await callEcho(claude, {})).not.toHaveProperty("caller");
        });

        it("registers nothing with the daemon: only the tool list and tool calls are requested", async () => {
            const requests = await fakeDaemon();
            const client = await connect("claude-code", stateless);
            await client.listTools();
            await callEcho(client, { "claudecode/toolUseId": "toolu_2" });
            await client.close();
            expect(new Set(requests.map((r) => r.url))).toEqual(new Set(["/api/tools", "/api/tools/call"]));
        });
    });
}

describe("Daemon autostart from the adapter", () => {
    async function closedPort(): Promise<number> {
        const probe = http.createServer();
        await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
        const port = (probe.address() as AddressInfo).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        return port;
    }

    async function runAgainst(endpoint: string, options: ConstructorParameters<typeof NexusServer>[0] = {}) {
        process.env.NEXUS_ENDPOINT = endpoint;
        const proxy = new NexusServer({ retryIntervalMs: 60_000, ...options });
        proxies.push(proxy);
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        await proxy.run({ transport: serverSide, input: new PassThrough(), onExit: () => { } });
    }

    it("tries to start a daemon once when nothing listens at the endpoint", async () => {
        const endpoint = `http://127.0.0.1:${await closedPort()}`;
        await runAgainst(endpoint);
        expect(autostart.calls).toEqual([endpoint]);
    });

    it("tries again once per outage when the daemon goes away while connected", async () => {
        await fakeDaemon();
        const endpoint = process.env.NEXUS_ENDPOINT!;
        const proxy = new NexusServer({ retryIntervalMs: 50 });
        proxies.push(proxy);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await proxy.run({ transport: serverSide, input: new PassThrough(), onExit: () => { } });
        const client = new Client({ name: "Cursor", version: "1" });
        clients.push(client);
        await client.connect(clientSide);
        await client.listTools();
        expect(autostart.calls).toEqual([]);

        const daemon = servers.pop()!;
        daemon.closeAllConnections();
        await new Promise<void>((resolve) => daemon.close(() => resolve()));
        const failed = await client.callTool({ name: "echo", arguments: {} });
        expect(failed.isError).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 400));     // several retry intervals
        expect(autostart.calls).toEqual([endpoint]);
    });

    it("repeats the failed call once when the started daemon comes up", async () => {
        await fakeDaemon();
        const port = Number(new URL(process.env.NEXUS_ENDPOINT!).port);
        const client = await connect("Cursor", false);
        await client.listTools();
        const daemon = servers.pop()!;
        daemon.closeAllConnections();
        await new Promise<void>((resolve) => daemon.close(() => resolve()));

        await new Promise((resolve) => setTimeout(resolve, 50));   // let the client see its pooled socket close
        let restarted: Recorded[] = [];
        autostart.start = async () => { restarted = await fakeDaemon(port); return true; };
        const result = await client.callTool({ name: "echo", arguments: { n: 1 } });
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        expect(autostart.calls).toHaveLength(1);
        expect(restarted.filter((r) => r.url === "/api/tools/call").map((r) => r.body.args)).toEqual([{ n: 1 }]);
    });

    it("does not start one when autostart is off", async () => {
        await runAgainst(`http://127.0.0.1:${await closedPort()}`, { autostart: false });
        expect(autostart.calls).toEqual([]);
    });

    it("does not start one when a daemon answers, or accepts but hangs", async () => {
        await fakeDaemon();
        await runAgainst(process.env.NEXUS_ENDPOINT!);
        const net = await import("node:net");
        const sockets: import("node:net").Socket[] = [];
        const hung = net.createServer((sock) => { sockets.push(sock); });
        await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
        await runAgainst(`http://127.0.0.1:${(hung.address() as AddressInfo).port}`, { requestTimeoutMs: 100 });
        expect(autostart.calls).toEqual([]);
        sockets.forEach((s) => s.destroy());
        await new Promise((resolve) => hung.close(resolve));
    });
});
