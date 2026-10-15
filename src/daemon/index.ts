import { createDaemonServer } from "./server.js";
import { closeDatabase } from "../storage/sqlite.js";
import { pkg } from "../config/index.js";
import { getArg } from "../config/cli.js";
import { getRootPath } from "../config/paths.js";
import { NEXUS_HOST, NEXUS_PORT } from "../constants.js";

function parsePort(): number {
    for (const candidate of [getArg("--port"), process.env.NEXUS_DAEMON_PORT]) {
        const parsed = parseInt(candidate || "", 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
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

    const { server } = await createDaemonServer({ port, host, version: pkg.version });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            console.error(`[n2n-nexus] Daemon v${pkg.version} listening on http://${host}:${port}`);
            console.error(`[n2n-nexus] Storage: ${root}`);
            resolve();
        });
    });

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
