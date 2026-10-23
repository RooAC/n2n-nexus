import type { AddressInfo } from "node:net";
import { createDaemonServer } from "./server.js";
import { closeDatabase } from "../storage/sqlite.js";
import { runTaskMaintenance } from "../storage/tasks.js";
import { TASK_MAINTENANCE_INTERVAL_MS } from "../constants.js";
import { pkg } from "../config/index.js";
import { getArg } from "../config/cli.js";
import { getRootPath } from "../config/paths.js";
import { NEXUS_HOST, NEXUS_PORT } from "../constants.js";
import { answersDiscovery, discoveryPort, startDiscoveryResponder } from "../client/discovery.js";

function parsePort(): number {
    for (const candidate of [getArg("--port"), process.env.NEXUS_DAEMON_PORT]) {
        const parsed = parseInt(candidate || "", 10);
        if (!isNaN(parsed) && parsed >= 0) return parsed;   // 0: any free port
    }
    return NEXUS_PORT;
}

function parseHost(): string {
    return getArg("--host") || process.env.NEXUS_HOST || NEXUS_HOST;
}

export async function runDaemon(): Promise<void> {
    const port = parsePort();
    const host = parseHost();
    const root = getRootPath();

    // Publish the resolved root so every storage module (which reads NEXUS_ROOT) agrees with the log line below
    process.env.NEXUS_ROOT = root;

    // Conformance tests shorten how long a listening Stop hook is held open.
    const listenWaitMs = parseInt(process.env.NEXUS_TEST_LISTEN_WAIT_MS || "", 10);
    const { server } = await createDaemonServer({ port, host, version: pkg.version, listenWaitMs: listenWaitMs > 0 ? listenWaitMs : undefined });

    // The bound port, not the requested one (0 = any free port); conformance tests read it from the log line.
    const boundPort = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            const bound = (server.address() as AddressInfo).port;
            console.error(`[n2n-nexus] Daemon v${pkg.version} listening on http://${host}:${bound}`);
            console.error(`[n2n-nexus] Storage: ${root}`);
            resolve(bound);
        });
    });

    // Reachable from the LAN: let clients configured with the endpoint `discover` find this daemon.
    if (answersDiscovery(host)) {
        try {
            await startDiscoveryResponder(boundPort, pkg.version, host);
            console.error(`[n2n-nexus] Answering LAN discovery on UDP ${discoveryPort()}`);
        } catch (e) {
            console.error(`[n2n-nexus] LAN discovery unavailable: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Expire overdue tasks and purge old finished ones at startup and then periodically
    const maintain = () => {
        const { expired, removed } = runTaskMaintenance();
        if (expired || removed) console.error(`[n2n-nexus] Task maintenance: ${expired} expired, ${removed} removed.`);
    };
    maintain();
    setInterval(maintain, TASK_MAINTENANCE_INTERVAL_MS).unref();

    // Graceful shutdown: stop accepting connections, let in-flight requests
    // finish, then close SQLite. A second signal exits immediately.
    const shutdown = (signal: string) => {
        console.error(`[n2n-nexus] ${signal} received, shutting down.`);
        server.close(() => {
            closeDatabase();
            process.exit(0);
        });
        process.once(signal, () => process.exit(1));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.on("exit", () => closeDatabase());

    console.error("[n2n-nexus] Ready. Press Ctrl+C to stop.");
}
