/**
 * `n2n-nexus hook <claude|codex> [--endpoint <url>]`: forward one client hook
 * event to the daemon and print its output. Runs on every tool call, so it
 * loads only node built-ins (no MCP SDK, zod or SQLite), and every failure is
 * silent: exit 0 with nothing on stdout, so the client carries on unaffected.
 */
import {
    HOOK_INPUT_FIELDS, HOOK_REQUEST_TIMEOUT_MS, HOOK_STOP_REQUEST_TIMEOUT_MS, isHookClient,
    type HookResponse
} from "../daemon/hook-contract.js";
import { NexusClient, NexusTransportError } from "../client/nexus-client.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:5688";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
}

function argValue(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
}

/** Returns the text to print on stdout ("" for nothing); throws on any failure. */
async function forward(argv: string[]): Promise<string> {
    const client = argv[0];
    if (!isHookClient(client)) throw new Error(`unknown client "${client ?? ""}" (expected claude or codex)`);
    const endpoint = argValue(argv, "--endpoint") || process.env.NEXUS_ENDPOINT || DEFAULT_ENDPOINT;

    const stdin: unknown = JSON.parse(await readStdin());
    if (!isPlainObject(stdin)) throw new Error("hook input is not a JSON object");
    const input: Record<string, unknown> = {};
    for (const field of HOOK_INPUT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(stdin, field)) input[field] = stdin[field];
    }
    const timeoutMs = stdin.hook_event_name === "Stop" ? HOOK_STOP_REQUEST_TIMEOUT_MS : HOOK_REQUEST_TIMEOUT_MS;

    const nexus = new NexusClient({ endpoint });
    const send = () => nexus.hook({ client, input }, timeoutMs);
    let response: HookResponse;
    try {
        response = await send();
    } catch (error) {
        if (!(error instanceof NexusTransportError && error.code === "ECONNREFUSED")) throw error;
        const { startLocalDaemon } = await import("./autostart.js");
        if (!await startLocalDaemon(endpoint)) throw error;
        response = await send();
    }

    if (!isPlainObject(response) || !("output" in response)) throw new Error("invalid response from daemon");
    const { output } = response;
    if (output === null) return "";
    if (!isPlainObject(output)) throw new Error("invalid output from daemon");
    return JSON.stringify(output) + "\n";
}

/** Run the hook command; always resolves to exit code 0. */
export async function runHook(argv: string[]): Promise<number> {
    let text = "";
    try {
        text = await forward(argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[n2n-nexus] hook: ${message.replace(/\s+/g, " ").slice(0, 300)}\n`);
    }
    if (text) {
        process.stdout.on("error", () => { /* the client stopped reading: nothing left to do */ });
        await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    }
    return 0;
}
