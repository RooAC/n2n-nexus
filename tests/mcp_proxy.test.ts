import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

describe("MCP proxy", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("mcp-proxy"); });
    afterEach(async () => { await daemon.close(); });

    async function connectProxy() {
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
        process.env.NEXUS_INSTANCE_ID = "proxy-test";
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const proxy = new NexusServer();
        await proxy.run({ transport: serverSide });
        const client = new Client({ name: "test-ide", version: "0.0.0" });
        await client.connect(clientSide);
        return { proxy, client };
    }

    it("keeps the tool list when a tool call fails", async () => {
        const { client } = await connectProxy();
        const before = await client.listTools();
        expect(before.tools.length).toBeGreaterThan(0);

        const failed = await client.callTool({ name: "get_task", arguments: { taskId: "nope" } });
        expect(failed.isError).toBe(true);
        expect(JSON.stringify(failed.content)).toContain("not found");

        const after = await client.listTools();
        expect(after.tools.length).toBe(before.tools.length);
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
        const client = new Client({ name: "Fancy IDE", version: "1.0" });
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
