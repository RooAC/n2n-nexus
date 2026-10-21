import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { NexusClient, NexusToolError, NexusTransportError } from "../src/client/nexus-client.js";

describe("NexusClient HTTP transport", () => {
    const servers: http.Server[] = [];

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(async (server) => {
            server.closeAllConnections();
            if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        }));
    });

    async function listen(handler: http.RequestListener, host = "127.0.0.1") {
        const server = http.createServer(handler);
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, host, () => {
                server.removeListener("error", reject);
                resolve();
            });
        });
        return `http://${host.includes(":") ? `[${host}]` : host}:${(server.address() as AddressInfo).port}`;
    }

    it("rejects an interrupted JSON response and allows the next request to succeed", async () => {
        let requests = 0;
        const endpoint = await listen((_req, res) => {
            if (requests++ === 0) {
                res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
                res.write('{"tools":', () => setImmediate(() => res.destroy()));
            } else {
                res.end(JSON.stringify({ tools: [] }));
            }
        });
        const client = new NexusClient({ endpoint, timeoutMs: 100 });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                client.fetchTools().catch((error: unknown) => error),
                new Promise((resolve) => { deadline = setTimeout(() => resolve("still pending"), 500); })
            ]);
            expect(result).toBeInstanceOf(NexusTransportError);
            await expect(client.fetchTools()).resolves.toEqual([]);
        } finally {
            clearTimeout(deadline);
        }
    });

    it("rejects a response that stops sending data when the timeout expires", async () => {
        const endpoint = await listen((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write('{"tools":');
        });
        const client = new NexusClient({ endpoint, timeoutMs: 50 });
        await expect(client.fetchTools()).rejects.toMatchObject({
            name: "NexusTransportError",
            message: expect.stringContaining("timed out")
        });
    });

    it("preserves caller and hook payloads, tool results, and HTTP error classification", async () => {
        const received: Array<{ path: string | undefined; body: unknown }> = [];
        const endpoint = await listen((req, res) => {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                received.push({ path: req.url, body: JSON.parse(body) });
                if (req.url === "/api/tools/call") {
                    const { tool } = JSON.parse(body);
                    if (tool === "missing") {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: "Unknown tool" }));
                    } else {
                        res.end(JSON.stringify({ ok: true, result: { count: 0 } }));
                    }
                } else {
                    res.end(JSON.stringify({ output: { decision: "block", reason: "r" } }));
                }
            });
        });
        const client = new NexusClient({ endpoint });
        const caller = { client: "codex", sessionId: "thread" } as const;
        await expect(client.callTool("read", {}, "instance", caller)).resolves.toEqual({ count: 0 });
        await expect(client.callTool("peers", {}, "instance")).resolves.toEqual({ count: 0 });
        const hook = { client: "claude", input: { hook_event_name: "Stop", session_id: "s" } } as const;
        await expect(client.hook(hook)).resolves.toEqual({ output: { decision: "block", reason: "r" } });
        await expect(client.callTool("missing", {})).rejects.toBeInstanceOf(NexusToolError);
        expect(received.slice(0, 3)).toEqual([
            { path: "/api/tools/call", body: { tool: "read", args: {}, instanceId: "instance", caller } },
            { path: "/api/tools/call", body: { tool: "peers", args: {}, instanceId: "instance" } },
            { path: "/api/hook", body: hook }
        ]);
    });

    it("lets a hook request outlast the client timeout and reports connection errors with their code", async () => {
        const endpoint = await listen((req, res) => {
            req.resume();
            req.on("end", () => setTimeout(() => res.end(JSON.stringify({ output: null })), 150));
        });
        const client = new NexusClient({ endpoint, timeoutMs: 50 });
        await expect(client.hook({ client: "codex", input: {} })).rejects.toMatchObject({ message: expect.stringContaining("timed out after 50 ms") });
        await expect(client.hook({ client: "codex", input: {} }, 1000)).resolves.toEqual({ output: null });

        const refused = new NexusClient({ endpoint: "http://127.0.0.1:1", timeoutMs: 500 });
        await expect(refused.fetchTools()).rejects.toMatchObject({ name: "NexusTransportError", code: "ECONNREFUSED" });
    });

    it("decodes a multi-byte UTF-8 character split across two response chunks", async () => {
        const text = "中文消息：跨块解码";
        const body = Buffer.from(JSON.stringify({ ok: true, result: { text } }), "utf8");
        // Split inside the first character's 3-byte sequence.
        const split = body.indexOf(Buffer.from("中", "utf8")) + 1;
        const endpoint = await listen((req, res) => {
            req.resume();
            req.on("end", () => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.write(body.subarray(0, split));
                setTimeout(() => res.end(body.subarray(split)), 30);
            });
        });
        await expect(new NexusClient({ endpoint }).callTool("read", {})).resolves.toEqual({ text });
    });

    it("connects to an IPv6 loopback endpoint", async (context) => {
        let endpoint: string;
        try {
            endpoint = await listen((_req, res) => res.end(JSON.stringify({ tools: [] })), "::1");
        } catch (error) {
            if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) {
                context.skip("IPv6 loopback is unavailable on this host");
                return;
            }
            throw error;
        }
        await expect(new NexusClient({ endpoint }).fetchTools()).resolves.toEqual([]);
    });
});
