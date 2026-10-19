import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { NexusServer } from "../src/server/nexus.js";

type RequestBody = { sessionId: string; instanceId: string; clientName?: string; workspace?: string; args?: unknown };
const proxies: NexusServer[] = [];
const clients: Client[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(proxies.splice(0).map((proxy) => proxy.shutdown()));
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fakeDaemon(onRequest?: (path: string, body: RequestBody, res: http.ServerResponse) => boolean) {
    const registrations: RequestBody[] = [];
    const sessions = new Map<string, RequestBody & { online: boolean }>();
    const server = http.createServer((req, res) => {
        let data = "";
        req.on("data", (chunk) => { data += chunk; });
        req.on("end", () => {
            const body = (data ? JSON.parse(data) : {}) as RequestBody;
            if (onRequest?.(req.url!, body, res)) return;
            if (req.url === "/api/tools") {
                res.end(JSON.stringify({ tools: [{ name: "echo", description: "Echo request", inputSchema: { type: "object", properties: {} } }] }));
            } else if (req.url === "/api/sessions/register") {
                registrations.push(body);
                sessions.set(body.sessionId, { ...body, online: true });
                res.end(JSON.stringify({ ok: true }));
            } else if (req.url === "/api/sessions/disconnect") {
                const session = sessions.get(body.sessionId);
                if (session) session.online = false;
                res.end(JSON.stringify({ ok: true }));
            } else {
                res.end(JSON.stringify({ ok: true, result: body }));
            }
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { registrations, sessions };
}

async function connect(stateless: boolean, options: ConstructorParameters<typeof NexusServer>[0] = {}) {
    const proxy = new NexusServer(options);
    proxies.push(proxy);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.run({ transport: serverSide });
    const client = new Client({ name: "Same IDE", version: "1" }, stateless ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
    clients.push(client);
    await client.connect(clientSide);
    return { proxy, client };
}

for (const stateless of [false, true]) {
    describe(`Session identity, ${stateless ? "2026-07-28" : "2025-11-25"} protocol`, () => {
        it("registers distinct sessions for matching IDE/workspace and attaches identity outside model arguments", async () => {
            delete process.env.NEXUS_INSTANCE_ID;
            const daemon = await fakeDaemon();
            const a = await connect(stateless);
            const b = await connect(stateless);
            expect(daemon.sessions.size).toBe(0);
            await a.client.listTools();
            await b.client.listTools();
            expect(daemon.sessions.size).toBe(2);
            const [first, second] = [...daemon.sessions.values()];
            expect(first.sessionId).not.toBe(second.sessionId);
            expect(first.instanceId).toBe(second.instanceId);
            expect(first.instanceId).toMatch(/-same-ide$/);
            expect(first).toMatchObject({ clientName: "Same IDE", workspace: process.cwd(), online: true });

            const result = await a.client.callTool({ name: "echo", arguments: { sessionId: second.sessionId, instanceId: "spoofed" } });
            expect(result.structuredContent).toMatchObject({ sessionId: first.sessionId, instanceId: first.instanceId });
            await a.client.close();
            await a.proxy.shutdown();
            expect(daemon.sessions.get(first.sessionId)?.online).toBe(false);
            expect(daemon.sessions.get(second.sessionId)?.online).toBe(true);
        });
    });
}

it("restores the same session after daemon state loss and stops heartbeats on client close", async () => {
    process.env.NEXUS_INSTANCE_ID = "heartbeat-test";
    const daemon = await fakeDaemon();
    const { client, proxy } = await connect(true, { heartbeatIntervalMs: 30 });
    await client.listTools();
    const original = daemon.registrations[0];
    daemon.sessions.clear();
    await expect.poll(() => daemon.sessions.get(original.sessionId)?.online).toBe(true);
    expect(new Set(daemon.registrations.map((s) => s.sessionId)).size).toBe(1);
    await client.close();
    await proxy.shutdown();
    const count = daemon.registrations.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(daemon.registrations).toHaveLength(count);
    expect(daemon.sessions.get(original.sessionId)?.online).toBe(false);
});

it("waits for an in-flight registration before disconnecting and never restarts its heartbeat", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    await fakeDaemon((path, _body, res) => {
        if (path === "/api/sessions/register") {
            events.push("register-start");
            release = () => { events.push("register-complete"); res.end(JSON.stringify({ ok: true })); };
            return true;
        }
        if (path === "/api/sessions/disconnect") events.push("disconnect");
        return false;
    });
    const { client, proxy } = await connect(true, { heartbeatIntervalMs: 20 });
    const list = client.listTools().catch(() => undefined);
    await expect.poll(() => release).toBeDefined();
    const shutdown = proxy.shutdown();
    release!();
    await shutdown;
    await list;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual(["register-start", "register-complete", "disconnect"]);
});

it("coalesces heartbeat and tool registrations while a daemon response is delayed", async () => {
    let delay = false;
    let pending = 0;
    let maximum = 0;
    let release: (() => void) | undefined;
    await fakeDaemon((path, _body, res) => {
        if (path !== "/api/sessions/register" || !delay) return false;
        pending++;
        maximum = Math.max(maximum, pending);
        release = () => { pending--; res.end(JSON.stringify({ ok: true })); };
        return true;
    });
    const { client, proxy } = await connect(true, { heartbeatIntervalMs: 20 });
    await client.listTools();
    delay = true;
    await expect.poll(() => release).toBeDefined();
    const call = client.callTool({ name: "echo", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(pending).toBe(1);
    expect(maximum).toBe(1);
    delay = false;
    release!();
    expect((await call).isError).toBeFalsy();
    await proxy.shutdown();
});
