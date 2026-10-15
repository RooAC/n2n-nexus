import {
    CLIENT_INFO_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    Server,
} from "@modelcontextprotocol/server";
import type { Tool, Transport } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { NexusClient, NexusToolError, NexusTransportError } from "../client/nexus-client.js";
import { pkg } from "../config/index.js";
import { resolveInstanceId } from "./instance-id.js";

const RETRY_INTERVAL_MS = 3000;
const SERVICE_NAME = "n2n-nexus";

export type RunOptions = {
    /** MCP transport; defaults to stdio. */
    transport?: Transport;
    /** Stream whose end means the client is gone; defaults to process.stdin when using stdio. */
    input?: NodeJS.ReadableStream;
    /** Called after shutdown triggered by `input` ending; defaults to process.exit(0). */
    onExit?: () => void;
};

type ClientInfo = { name?: string };

/**
 * Stateless MCP adapter in front of the daemon.
 *
 * Served through the v2 SDK's serveStdio entry, which answers both
 * protocol eras on one connection: 2026-07-28 clients (per-request `_meta`
 * envelope, `server/discover`, `subscriptions/listen`) and 2025-era clients
 * (`initialize` handshake).
 */
export class NexusServer {
    private server: Server | null = null;
    private handle: StdioServerHandle | null = null;
    private client: NexusClient;
    private cachedTools: Tool[] = [];
    private retryTimer: NodeJS.Timeout | null = null;
    private connected = false;
    private stopped = false;

    constructor() {
        const endpoint = process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
        this.client = new NexusClient({ endpoint, timeoutMs: 5000 });
    }

    /** Builds the MCP server instance serveStdio pins for the connection. */
    private buildServer(): Server {
        const server = new Server(
            { name: SERVICE_NAME, version: pkg.version },
            { capabilities: { tools: { listChanged: true } } }
        );

        server.setRequestHandler("tools/list", async () => ({ tools: this.cachedTools }));

        server.setRequestHandler("tools/call", async (request, ctx) => {
            if (!this.connected) {
                return {
                    content: [{ type: "text", text: "Daemon is not ready yet. Please wait a moment and retry." }],
                    isError: true
                };
            }

            // Unknown tool is a protocol error (JSON-RPC -32602), not a tool execution error.
            const unknownTool = () => new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
            if (!this.cachedTools.some((t) => t.name === request.params.name)) throw unknownTool();

            // 2026-07-28 clients identify themselves per request; 2025-era clients did so in initialize.
            const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
            const clientName = (envelope?.[CLIENT_INFO_META_KEY] as ClientInfo | undefined)?.name
                ?? server.getClientVersion()?.name;
            const instanceId = resolveInstanceId(process.env, process.argv, process.cwd(), clientName);

            try {
                const result = await this.client.callTool(request.params.name, request.params.arguments, instanceId);
                return {
                    content: [{
                        type: "text",
                        text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
                    }]
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                // The daemon dropped the tool since the list was fetched.
                if (e instanceof NexusToolError && e.status === 404) throw unknownTool();
                if (!(e instanceof NexusTransportError)) {
                    // The daemon answered; the tool itself failed. Keep the tool list.
                    return { content: [{ type: "text", text: message }], isError: true };
                }
                // Daemon went away — drop the tool list and start the retry loop
                if (this.connected) {
                    this.connected = false;
                    this.cachedTools = [];
                    await this.notifyToolsChanged();
                    this.scheduleRetry();
                }
                return {
                    content: [{ type: "text", text: `Daemon unavailable: ${message}. Reconnecting...` }],
                    isError: true
                };
            }
        });

        this.server = server;
        return server;
    }

    /** Delivered unsolicited on 2025-era connections and via subscriptions/listen on 2026-07-28 ones. */
    private async notifyToolsChanged(): Promise<void> {
        await this.server?.sendToolListChanged().catch(() => { });
    }

    private async tryConnect(): Promise<boolean> {
        try {
            const tools = await this.client.fetchTools();
            // JSON Schema produced by the daemon; the SDK models it as JSON values.
            this.cachedTools = tools as unknown as Tool[];
            this.connected = true;
            console.error(`[n2n-nexus] Connected to daemon. ${tools.length} tools loaded.`);
            await this.notifyToolsChanged();
            return true;
        } catch {
            return false;
        }
    }

    private stopRetry() {
        if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
        }
    }

    /** Stop reconnecting and close the MCP connection. Safe to call more than once. */
    async shutdown(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.stopRetry();
        await this.handle?.close().catch(() => { });
    }

    private scheduleRetry() {
        if (this.retryTimer || this.stopped) return;
        const endpoint = process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
        this.retryTimer = setInterval(async () => {
            console.error(`[n2n-nexus] Waiting for daemon at ${endpoint}...`);
            const ok = await this.tryConnect();
            if (ok && this.retryTimer) {
                clearInterval(this.retryTimer);
                this.retryTimer = null;
            }
        }, RETRY_INTERVAL_MS);
    }

    /**
     * Serve MCP. Per the stdio transport spec the server should exit when its
     * input closes; without that the reconnect timer would keep the adapter
     * alive after the IDE went away.
     */
    async run(options: RunOptions = {}) {
        const stdio = !options.transport;
        const input: NodeJS.ReadableStream | undefined = options.input ?? (stdio ? process.stdin : undefined);
        const onExit = options.onExit ?? (() => process.exit(0));

        if (input) {
            const exit = () => { void this.shutdown().then(onExit); };
            input.once("end", exit);
            input.once("close", exit);
        }

        // Fetch the tool list before serving, so the first tools/list already has it when the
        // daemon is up (2026-07-28 clients only hear list_changed if they subscribe).
        const ok = await this.tryConnect();

        this.handle = serveStdio(() => this.buildServer(), {
            transport: options.transport,
            onerror: (err) => console.error("[n2n-nexus] MCP transport error:", err.message)
        });

        if (!ok) {
            const endpoint = process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
            console.error(`[n2n-nexus] Daemon not available at ${endpoint}. Will retry every ${RETRY_INTERVAL_MS / 1000}s...`);
            this.scheduleRetry();
        }
    }
}
