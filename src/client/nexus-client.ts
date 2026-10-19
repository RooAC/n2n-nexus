import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export type ToolDefinition = {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
    annotations?: Record<string, unknown>;
};

export type NexusClientOptions = {
    endpoint?: string;
    timeoutMs?: number;
};

/** The daemon could not be reached or answered with something that is not JSON. */
export class NexusTransportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NexusTransportError";
    }
}

/** The daemon answered, but the tool call itself failed (unknown tool, validation, not found, ...). */
export class NexusToolError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
        this.name = "NexusToolError";
    }
}

function normalizeEndpoint(endpoint?: string): string {
    const raw = endpoint || process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
    if (/^https?:\/\//i.test(raw)) return raw;
    return `http://${raw}`;
}

export class NexusClient {
    private endpoint: string;
    private timeoutMs: number;

    constructor(options: NexusClientOptions = {}) {
        this.endpoint = normalizeEndpoint(options.endpoint);
        this.timeoutMs = options.timeoutMs ?? 5000;
    }

    private request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const url = new URL(path, this.endpoint);
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const transport = url.protocol === "https:" ? https : http;

        return new Promise((resolve, reject) => {
            const req = transport.request(
                url,
                {
                    method,
                    headers: {
                        "Content-Type": "application/json",
                        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
                    },
                    timeout: this.timeoutMs
                },
                (res) => {
                    let data = "";
                    const interrupted = () => reject(new NexusTransportError("Response from daemon ended before completion"));
                    res.on("aborted", interrupted);
                    res.on("error", (error) => reject(new NexusTransportError(error.message)));
                    res.on("close", () => { if (!res.complete) interrupted(); });
                    res.on("data", chunk => { data += chunk; });
                    res.on("end", () => {
                        let parsed: { error?: string };
                        try {
                            parsed = data ? JSON.parse(data) : {};
                        } catch {
                            reject(new NexusTransportError(`Invalid JSON response from daemon: ${data.slice(0, 200)}`));
                            return;
                        }
                        const status = res.statusCode ?? 0;
                        if (status >= 400) {
                            reject(new NexusToolError(parsed.error || `HTTP ${status}`, status));
                        } else {
                            resolve(parsed as T);
                        }
                    });
                }
            );

            req.on("error", (e) => reject(e instanceof NexusTransportError ? e : new NexusTransportError(e.message)));
            req.on("timeout", () => req.destroy(new NexusTransportError(`Request to ${this.endpoint} timed out after ${this.timeoutMs} ms`)));
            if (payload) req.write(payload);
            req.end();
        });
    }

    async fetchTools(): Promise<ToolDefinition[]> {
        const res = await this.request<{ tools: ToolDefinition[] }>("GET", "/api/tools");
        return res.tools;
    }

    async registerSession(session: { sessionId: string; instanceId: string; clientName?: string; workspace?: string }): Promise<void> {
        await this.request("POST", "/api/sessions/register", session);
    }

    async disconnectSession(sessionId: string, instanceId: string): Promise<void> {
        await this.request("POST", "/api/sessions/disconnect", { sessionId, instanceId });
    }

    async callTool(name: string, args: unknown, instanceId?: string, sessionId?: string): Promise<unknown> {
        const res = await this.request<{ ok: boolean; result: unknown; error?: string }>(
            "POST", "/api/tools/call",
            { tool: name, args: args || {}, instanceId: instanceId || "unknown", ...(sessionId ? { sessionId } : {}) }
        );
        if (!res.ok) throw new NexusToolError(res.error || "Tool call failed", 200);
        return res.result;
    }
}
