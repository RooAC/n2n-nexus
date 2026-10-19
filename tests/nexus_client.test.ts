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

    it("preserves session payloads, tool results, and HTTP error classification", async () => {
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
                    res.end(JSON.stringify({ ok: true }));
                }
            });
        });
        const client = new NexusClient({ endpoint });
        const session = { sessionId: "session", instanceId: "instance", clientName: "IDE", workspace: "/project" };
        await client.registerSession(session);
        await expect(client.callTool("read_inbox", {}, "instance", "session")).resolves.toEqual({ count: 0 });
        await client.disconnectSession("session", "instance");
        await expect(client.callTool("missing", {})).rejects.toBeInstanceOf(NexusToolError);
        expect(received.slice(0, 3)).toEqual([
            { path: "/api/sessions/register", body: session },
            { path: "/api/tools/call", body: { tool: "read_inbox", args: {}, instanceId: "instance", sessionId: "session" } },
            { path: "/api/sessions/disconnect", body: { sessionId: "session", instanceId: "instance" } }
        ]);
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
