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
                {
                    method,
                    protocol: url.protocol,
                    hostname: url.hostname,
                    port: url.port,
                    path: `${url.pathname}${url.search}`,
                    headers: {
                        "Content-Type": "application/json",
                        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
                    },
                    timeout: this.timeoutMs
                },
                (res) => {
                    let data = "";
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

    async health(): Promise<{ ok: boolean; version: string }> {
        return this.request("GET", "/health");
    }

    async fetchTools(): Promise<ToolDefinition[]> {
        const res = await this.request<{ tools: ToolDefinition[] }>("GET", "/api/tools");
        return res.tools;
    }

    async callTool(name: string, args: unknown, instanceId?: string): Promise<unknown> {
        const res = await this.request<{ ok: boolean; result: unknown; error?: string }>(
            "POST", "/api/tools/call",
            { tool: name, args: args || {}, instanceId: instanceId || "unknown" }
        );
        if (!res.ok) throw new NexusToolError(res.error || "Tool call failed", 200);
        return res.result;
    }
}
