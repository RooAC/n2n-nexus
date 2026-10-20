import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NexusClient } from "../client/nexus-client.js";

const PROBE_INTERVAL_MS = 100;
const PROBE_DEADLINE_MS = 2_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Absolute path of the package entry script (`build/index.js` next to `build/cli/`). */
export function entryScript(): string {
    return fileURLToPath(new URL("../index.js", import.meta.url));
}

function parseEndpoint(endpoint: string): URL {
    return new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Start a daemon in the background when a hook or the MCP adapter finds none
 * listening at a local endpoint (127.0.0.1 or localhost). Resolves true once
 * GET /api/tools answers (polled every 100 ms for up to 2 s), false when the
 * endpoint is not local or the daemon did not come up in time. Never throws.
 *
 * Two callers racing here each spawn a daemon; the one that loses the port
 * exits with EADDRINUSE and both callers see the winner answer the probe.
 */
export async function startLocalDaemon(endpoint: string): Promise<boolean> {
    try {
        const url = parseEndpoint(endpoint);
        if (!LOCAL_HOSTS.has(url.hostname)) return false;
        const port = url.port || (url.protocol === "https:" ? "443" : "80");

        const logDir = path.join(os.homedir(), ".n2n-nexus");
        fs.mkdirSync(logDir, { recursive: true });
        const log = fs.openSync(path.join(logDir, "daemon.log"), "a");
        try {
            const child = spawn(process.execPath, [entryScript(), "daemon", "--port", port], {
                detached: true,
                stdio: ["ignore", log, log],
                env: process.env
            });
            child.on("error", () => { /* reported through the failed probe */ });
            child.unref();
        } finally {
            fs.closeSync(log);
        }

        const client = new NexusClient({ endpoint: url.href, timeoutMs: 500 });
        const deadline = Date.now() + PROBE_DEADLINE_MS;
        while (Date.now() < deadline) {
            try {
                await client.fetchTools();
                return true;
            } catch {
                await sleep(PROBE_INTERVAL_MS);
            }
        }
        return false;
    } catch {
        return false;
    }
}
