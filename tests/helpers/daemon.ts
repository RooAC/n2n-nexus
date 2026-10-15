import http from "node:http";
import { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";

import { createDaemonServer } from "../../src/daemon/server.js";
import { closeDatabase } from "../../src/storage/sqlite.js";
import { StorageManager } from "../../src/storage/index.js";

export type DaemonHarness = {
    port: number;
    root: string;
    request: <T>(method: string, route: string, body?: unknown) => Promise<{ status: number; payload: T }>;
    callTool: <T>(tool: string, args: Record<string, unknown>, instanceId?: string) => Promise<{ status: number; payload: { ok: boolean; result?: T; error?: string } }>;
    close: () => Promise<void>;
};

export function requestJson<T>(port: number, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; payload: T }> {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
            {
                method,
                hostname: "127.0.0.1",
                port,
                path: route,
                headers: {
                    "Content-Type": "application/json",
                    ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
                    ...headers
                }
            },
            (res) => {
                let raw = "";
                res.on("data", (chunk) => (raw += chunk));
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode || 0, payload: raw ? (JSON.parse(raw) as T) : ({} as T) });
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

/** Start a daemon on a fresh storage root under tests/tmp/<name>. */
export async function startTestDaemon(name: string): Promise<DaemonHarness> {
    const root = path.join(process.cwd(), "tests", "tmp", name);
    closeDatabase();
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    process.env.NEXUS_ROOT = root;
    StorageManager.resetInit();

    const { server } = await createDaemonServer({ port: 0, version: "test" });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;

    return {
        port,
        root,
        request: (method, route, body) => requestJson(port, method, route, body),
        callTool: (tool, args, instanceId = "test-instance") =>
            requestJson(port, "POST", "/api/tools/call", { tool, args, instanceId }),
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            closeDatabase();
        }
    };
}
