import {
    CLIENT_INFO_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    Server,
} from "@modelcontextprotocol/server";
import type { Tool, Transport } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { NexusClient, NexusToolError, NexusTransportError } from "../client/nexus-client.js";
import { startLocalDaemon } from "../cli/autostart.js";
import { pkg } from "../config/index.js";
import { CLAUDE_TOOL_USE_META_KEY, CLIENT_INFO_NAMES, CODEX_SESSION_META_KEY, type Caller } from "../daemon/hook-contract.js";
import { resolveInstanceId } from "./instance-id.js";

const RETRY_INTERVAL_MS = 3000;
/** How long the first tools/list waits for the startup daemon fetch before answering with what it has. */
const INITIAL_LIST_WAIT_MS = 1000;
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

export type NexusServerOptions = {
    /** Pause between reconnect attempts, measured from the end of the previous attempt. */
    retryIntervalMs?: number;
    /** Per-request timeout towards the daemon. */
    requestTimeoutMs?: number;
    /** Start a daemon when none is listening at a local endpoint (default true). */
    autostart?: boolean;
};

/**
 * MCP adapter in front of the daemon. It holds no session of its own: each
 * tool call carries the caller the client named in the request's `_meta`
 * (see hook-contract.ts), so one adapter can serve several conversations.
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
    /** True while a reconnect loop is active (waiting or attempting). */
    private retrying = false;
    private readonly retryIntervalMs: number;
    private readonly endpoint: string;
    private readonly autostart: boolean;
    private instanceId: string | undefined;
    private readonly workspace = process.cwd();
    /** Error code of the last failed connection attempt, e.g. "ECONNREFUSED". */
    private lastConnectError: string | undefined;
    private shutdownPromise: Promise<void> | null = null;
    private connected = false;
    private stopped = false;
    /**
     * First client name seen on this stdio connection. clientInfo is only a
     * SHOULD per request under 2026-07-28, so a request without it must not
     * fall back to a different instance id than its siblings.
     */
    private clientName: string | undefined;
    /** The first daemon fetch, started once serving has begun. */
    private initialFetch: Promise<boolean> | null = null;

    constructor(options: NexusServerOptions = {}) {
        this.endpoint = process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
        this.retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
        this.autostart = options.autostart ?? true;
        this.client = new NexusClient({ endpoint: this.endpoint, timeoutMs: options.requestTimeoutMs ?? 5000 });
    }

    /** Builds the MCP server instance serveStdio pins for the connection. */
    private buildServer(): Server {
        const server = new Server(
            { name: SERVICE_NAME, version: pkg.version },
            { capabilities: { tools: { listChanged: true } } }
        );

        server.setRequestHandler("tools/list", async (_request, ctx) => {
            this.identifyClient(ctx.mcpReq.envelope, server);
            // Give a local daemon a moment so the first list is complete; never block on a hung one.
            if (!this.connected && this.initialFetch) {
                await Promise.race([this.initialFetch, new Promise((r) => setTimeout(r, INITIAL_LIST_WAIT_MS))]);
            }
            return { tools: this.cachedTools };
        });

        server.setRequestHandler("tools/call", async (request, ctx) => {
            this.identifyClient(ctx.mcpReq.envelope, server);
            if (!this.connected) {
                return {
                    content: [{ type: "text", text: "Daemon is not ready yet. Please wait a moment and retry." }],
                    isError: true
                };
            }

            // Unknown tool is a protocol error (JSON-RPC -32602), not a tool execution error.
            const unknownTool = () => new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
            if (!this.cachedTools.some((t) => t.name === request.params.name)) throw unknownTool();

            let callingTool = false;
            try {
                if (this.stopped) throw new NexusTransportError("MCP connection is closed");
                callingTool = true;
                const caller = this.callerOf(request.params._meta);
                const result = await this.client.callTool(request.params.name, request.params.arguments, this.instanceId, caller);
                // Every daemon result is a JSON object, so it goes out as structuredContent
                // (data tools also publish an outputSchema for it; write tools do not). The
                // JSON text keeps clients that only read content working (the spec's
                // backwards-compatibility advice).
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    structuredContent: result as Record<string, unknown>
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                // The daemon dropped the tool since the list was fetched: resync so tools/list stops offering it.
                if (callingTool && e instanceof NexusToolError && e.status === 404) {
                    await this.refreshTools();
                    throw unknownTool();
                }
                if (!(e instanceof NexusTransportError)) {
                    // The daemon answered; the tool itself failed. Keep the tool list.
                    return { content: [{ type: "text", text: message }], isError: true };
                }
                // Daemon went away — drop the tool list and start the retry loop
                await this.daemonUnavailable();
                return {
                    content: [{ type: "text", text: `Daemon unavailable: ${message}. Reconnecting...` }],
                    isError: true
                };
            }
        });

        this.server = server;
        return server;
    }

    private identifyClient(meta: unknown, server: Server): void {
        if (this.instanceId) return;
        const envelope = meta as Record<string, unknown> | undefined;
        this.clientName = (envelope?.[CLIENT_INFO_META_KEY] as ClientInfo | undefined)?.name
            ?? server.getClientVersion()?.name;
        this.instanceId = resolveInstanceId(process.env, process.argv, this.workspace, this.clientName);
    }

    /** The conversation behind a tool call, from the `_meta` its client attaches (verified for Claude Code and Codex). */
    private callerOf(meta: unknown): Caller | undefined {
        const fields = meta as Record<string, unknown> | undefined;
        if (this.clientName === CLIENT_INFO_NAMES.claude) {
            const toolUseId = fields?.[CLAUDE_TOOL_USE_META_KEY];
            return typeof toolUseId === "string" && toolUseId ? { client: "claude", toolUseId } : undefined;
        }
        if (this.clientName === CLIENT_INFO_NAMES.codex) {
            const sessionId = fields?.[CODEX_SESSION_META_KEY];
            return typeof sessionId === "string" && sessionId ? { client: "codex", sessionId } : undefined;
        }
        return undefined;
    }

    private async daemonUnavailable(): Promise<void> {
        if (this.connected) {
            this.connected = false;
            this.cachedTools = [];
            await this.notifyToolsChanged();
        }
        this.scheduleRetry();
    }

    /** Delivered unsolicited on 2025-era connections and via subscriptions/listen on 2026-07-28 ones. */
    private async notifyToolsChanged(): Promise<void> {
        await this.server?.sendToolListChanged().catch(() => { });
    }

    /** Re-fetch the daemon's tool list; notify the client if it changed. */
    private async refreshTools(): Promise<void> {
        try {
            const tools = await this.client.fetchTools() as unknown as Tool[];
            const before = JSON.stringify(this.cachedTools);
            this.cachedTools = tools;
            if (JSON.stringify(tools) !== before) await this.notifyToolsChanged();
        } catch {
            // Transport trouble is handled by the next call; keep the current list.
        }
    }

    private async tryConnect(): Promise<boolean> {
        try {
            const tools = await this.client.fetchTools();
            if (this.stopped) return false;
            // JSON Schema produced by the daemon; the SDK models it as JSON values.
            this.cachedTools = tools as unknown as Tool[];
            this.connected = true;
            console.error(`[n2n-nexus] Connected to daemon. ${tools.length} tools loaded.`);
            await this.notifyToolsChanged();
            return true;
        } catch (e) {
            this.lastConnectError = e instanceof NexusTransportError ? e.code : undefined;
            return false;
        }
    }

    private stopRetry() {
        this.retrying = false;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    /** Stop reconnecting and close the MCP connection. Safe to call more than once. */
    shutdown(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.stopped = true;
        this.stopRetry();
        this.shutdownPromise = (async () => {
            await this.handle?.close().catch(() => { });
        })();
        return this.shutdownPromise;
    }

    /**
     * Reconnect loop. Each attempt is scheduled only after the previous one
     * finished, so a daemon that hangs (attempt longer than the interval)
     * never accumulates concurrent requests.
     */
    private scheduleRetry() {
        if (this.retrying || this.stopped) return;
        this.retrying = true;
        const next = () => {
            this.retryTimer = setTimeout(async () => {
                console.error(`[n2n-nexus] Waiting for daemon at ${this.endpoint}...`);
                const ok = await this.tryConnect();
                if (!this.retrying) return;           // stopped while the attempt was in flight
                // A tools/call may have lost the daemon again while this attempt was still
                // notifying the client; only stop if the connection is still up.
                if (ok && this.connected) this.stopRetry();
                else next();
            }, this.retryIntervalMs);
        };
        next();
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

        // Serve first so discover/initialize are answered even when the daemon hangs;
        // tools/list briefly waits for this fetch (2026-07-28 clients only hear
        // list_changed if they subscribe).
        const transport = options.transport ?? new StdioServerTransport();
        this.handle = serveStdio(() => this.buildServer(), {
            transport,
            onerror: (err) => console.error("[n2n-nexus] MCP transport error:", err.message)
        });
        const onclose = transport.onclose;
        transport.onclose = () => {
            onclose?.();
            void this.shutdown();
        };

        this.initialFetch = (async () => {
            if (await this.tryConnect()) return true;
            // Nothing listening at a local endpoint: start a daemon instead of waiting for one.
            if (!this.autostart || this.stopped || this.lastConnectError !== "ECONNREFUSED") return false;
            return await startLocalDaemon(this.endpoint) && await this.tryConnect();
        })();
        const ok = await this.initialFetch;
        if (!ok && !this.stopped) {
            console.error(`[n2n-nexus] Daemon not available at ${this.endpoint}. Will retry every ${this.retryIntervalMs / 1000}s...`);
            this.scheduleRetry();
        }
    }
}
