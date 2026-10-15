import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { NexusClient, NexusTransportError, ToolDefinition } from "../client/nexus-client.js";
import { pkg } from "../config/index.js";
import { resolveInstanceId } from "./instance-id.js";

const RETRY_INTERVAL_MS = 3000;

export type RunOptions = {
    /** MCP transport; defaults to stdio. */
    transport?: Transport;
    /** Stream whose end means the client is gone; defaults to process.stdin when using stdio. */
    input?: NodeJS.ReadableStream;
    /** Called after shutdown triggered by `input` ending; defaults to process.exit(0). */
    onExit?: () => void;
};
const SERVICE_NAME = "n2n-nexus";

export class NexusServer {
    private server: Server;
    private client: NexusClient;
    private instanceId: string | null = null;
    private cachedTools: ToolDefinition[] = [];
    private retryTimer: NodeJS.Timeout | null = null;
    private connected = false;
    private stopped = false;

    constructor() {
        const endpoint = process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
        this.client = new NexusClient({ endpoint, timeoutMs: 5000 });

        this.server = new Server(
            { name: SERVICE_NAME, version: pkg.version },
            { capabilities: { tools: { listChanged: true } } }
        );

        this.setupHandlers();
    }

    private setupHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: this.cachedTools
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (!this.connected) {
                return {
                    content: [{ type: "text", text: "Daemon is not ready yet. Please wait a moment and retry." }],
                    isError: true
                };
            }

            try {
                const result = await this.client.callTool(
                    request.params.name,
                    request.params.arguments,
                    this.getInstanceId()
                );
                return {
                    content: [{
                        type: "text",
                        text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
                    }]
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                if (!(e instanceof NexusTransportError)) {
                    // The daemon answered; the tool itself failed. Keep the tool list.
                    return { content: [{ type: "text", text: message }], isError: true };
                }
                // Daemon went away — drop the tool list and start the retry loop
                if (this.connected) {
                    this.connected = false;
                    this.cachedTools = [];
                    await this.server.sendToolListChanged();
                    this.scheduleRetry();
                }
                return {
                    content: [{ type: "text", text: `Daemon unavailable: ${message}. Reconnecting...` }],
                    isError: true
                };
            }
        });
    }

    /** Resolved on first use so the IDE's name from the MCP initialize handshake is available. */
    private getInstanceId(): string {
        if (!this.instanceId) {
            this.instanceId = resolveInstanceId(process.env, process.argv, process.cwd(), this.server.getClientVersion()?.name);
        }
        return this.instanceId;
    }

    private async tryConnect(): Promise<boolean> {
        try {
            const tools = await this.client.fetchTools();
            this.cachedTools = tools;
            this.connected = true;
            console.error(`[n2n-nexus] Connected to daemon. ${tools.length} tools loaded.`);
            await this.server.sendToolListChanged();
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
        await this.server.close().catch(() => { });
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
     * Connect the MCP server. Per the stdio transport spec the server should
     * exit when its input closes; without this the reconnect timer kept the
     * adapter alive after the IDE went away.
     */
    async run(options: RunOptions = {}) {
        const stdio = !options.transport;
        const transport = options.transport ?? new StdioServerTransport();
        const input: NodeJS.ReadableStream | undefined = options.input ?? (stdio ? process.stdin : undefined);
        const onExit = options.onExit ?? (() => process.exit(0));

        this.server.onclose = () => this.stopRetry();
        if (input) {
            const exit = () => { void this.shutdown().then(onExit); };
            input.once("end", exit);
            input.once("close", exit);
        }

        await this.server.connect(transport);

        // Try to connect immediately; if not ready, start retry loop
        const ok = await this.tryConnect();
        if (!ok) {
            const endpoint = process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
            console.error(`[n2n-nexus] Daemon not available at ${endpoint}. Will retry every ${RETRY_INTERVAL_MS / 1000}s...`);
            this.scheduleRetry();
        }
    }
}
