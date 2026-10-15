import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PassThrough } from "node:stream";

import { NexusServer } from "../src/server/nexus.js";
import { NexusClient, NexusToolError, NexusTransportError } from "../src/client/nexus-client.js";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";

describe("NexusClient error classification", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("nexus-client"); });
    afterEach(async () => { await daemon.close(); });

    it("reports a failed tool call as NexusToolError", async () => {
        const client = new NexusClient({ endpoint: `http://127.0.0.1:${daemon.port}` });
        await expect(client.callTool("get_task", { taskId: "nope" }, "t")).rejects.toBeInstanceOf(NexusToolError);
        await expect(client.callTool("no_such_tool", {}, "t")).rejects.toMatchObject({ name: "NexusToolError", status: 404 });
    });

    it("reports an unreachable daemon as NexusTransportError", async () => {
        const port = daemon.port;
        await daemon.close();
        const client = new NexusClient({ endpoint: `http://127.0.0.1:${port}`, timeoutMs: 500 });
        await expect(client.fetchTools()).rejects.toBeInstanceOf(NexusTransportError);
        await expect(client.callTool("get_task", { taskId: "x" }, "t")).rejects.toBeInstanceOf(NexusTransportError);
    });
});

// The adapter serves both protocol eras: 2025-era clients open with `initialize`,
// 2026-07-28 clients probe with `server/discover` and send a `_meta` envelope per request.
const ERAS = {
    "2025-11-25 (initialize)": undefined,
    "2026-07-28 (stateless)": { mode: { pin: "2026-07-28" } }
} as const;

describe.each(Object.entries(ERAS))("MCP proxy, %s client", (_era, versionNegotiation) => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("mcp-proxy"); });
    afterEach(async () => { await daemon.close(); });

    const newClient = (name: string) => new Client({ name, version: "1.0" }, versionNegotiation ? { versionNegotiation } : {});

    async function connectProxy() {
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
        process.env.NEXUS_INSTANCE_ID = "proxy-test";
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const proxy = new NexusServer();
        await proxy.run({ transport: serverSide });
        const client = newClient("test-ide");
        await client.connect(clientSide);
        return { proxy, client };
    }

    it("keeps the tool list when a tool call fails", async () => {
        const { client } = await connectProxy();
        const before = await client.listTools();
        expect(before.tools.length).toBeGreaterThan(0);
        const del = before.tools.find((t) => t.name === "host_delete_project");
        expect(del?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });

        const failed = await client.callTool({ name: "get_task", arguments: { taskId: "nope" } });
        expect(failed.isError).toBe(true);
        expect(JSON.stringify(failed.content)).toContain("not found");

        const after = await client.listTools();
        expect(after.tools.length).toBe(before.tools.length);
        await client.close();
    });

    it("answers an unknown tool with a JSON-RPC InvalidParams error", async () => {
        const { client } = await connectProxy();
        await expect(client.callTool({ name: "no_such_tool", arguments: {} }))
            .rejects.toMatchObject({ code: -32602, message: expect.stringContaining("Unknown tool: no_such_tool") });
        // The connection and tool list are unaffected.
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
        await client.close();
    });

    it("forwards successful calls and returns the daemon result", async () => {
        const { client } = await connectProxy();
        const result = await client.callTool({ name: "send_message", arguments: { message: "hi" } });
        expect(result.isError).toBeFalsy();
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(JSON.parse(text)).toMatchObject({ ok: true, sentTo: "global" });
        await client.close();
    });

    it("derives the instance id from the IDE name when none is pinned", async () => {
        delete process.env.NEXUS_INSTANCE_ID;
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await new NexusServer().run({ transport: serverSide });
        const client = newClient("Fancy IDE");
        await client.connect(clientSide);
        await client.callTool({ name: "send_message", arguments: { message: "from ide" } });
        const recent = await daemon.callTool<{ messages: { from: string }[] }>("read_messages", { count: 5 }, "observer");
        expect(recent.payload.result?.messages[0].from).toMatch(/^mcp-.+-[0-9a-f]{8}-fancy-ide$/);
        await client.close();
    });
});

describe("MCP proxy lifecycle", () => {
    it("shuts down and exits when its input ends, even while waiting for the daemon", async () => {
        process.env.NEXUS_ENDPOINT = "http://127.0.0.1:1"; // nothing listens here
        process.env.NEXUS_INSTANCE_ID = "lifecycle-test";
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        const input = new PassThrough();
        let exited = false;
        const proxy = new NexusServer();
        await proxy.run({ transport: serverSide, input, onExit: () => { exited = true; } });
        expect((proxy as unknown as { retryTimer: unknown }).retryTimer).not.toBeNull();

        input.resume(); // the stdio transport keeps stdin flowing; mimic that so "end" fires
        input.end();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(exited).toBe(true);
        expect((proxy as unknown as { retryTimer: unknown }).retryTimer).toBeNull();
    });
});

describe("MCP proxy instance id on 2026-07-28 connections", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("mcp-proxy-raw"); });
    afterEach(async () => { await daemon.close(); });

    it("keeps one instance id when later requests omit clientInfo", async () => {
        delete process.env.NEXUS_INSTANCE_ID;
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await new NexusServer().run({ transport: serverSide });

        const responses = new Map<number, unknown>();
        clientSide.onmessage = (m) => { const msg = m as { id?: number }; if (msg.id !== undefined) responses.set(msg.id, msg); };
        await clientSide.start();
        const meta = (withInfo: boolean) => ({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            ...(withInfo ? { "io.modelcontextprotocol/clientInfo": { name: "Fancy IDE", version: "1" } } : {})
        });
        const call = async (id: number, text: string, withInfo: boolean) => {
            await clientSide.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "send_message", arguments: { message: text }, _meta: meta(withInfo) } });
            for (let i = 0; i < 100 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 10));
        };
        await call(1, "with info", true);
        await call(2, "without info", false);

        const read = await daemon.callTool<{ messages: { from: string }[] }>("read_messages", { count: 5 }, "observer");
        const senders = new Set(read.payload.result?.messages.map((m) => m.from));
        expect(read.payload.result?.messages).toHaveLength(2);
        expect([...senders]).toHaveLength(1);
        expect([...senders][0]).toMatch(/-fancy-ide$/);
        await clientSide.close();
    });
});
