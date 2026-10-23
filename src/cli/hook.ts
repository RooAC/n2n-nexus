/**
 * `n2n-nexus hook <claude|codex> [--endpoint <url>] [--wait]`: forward one client
 * hook event to the daemon and print its output, or with `--wait` run the
 * background wait that wakes an idle conversation. Runs on every tool call, so
 * it loads only node built-ins (no MCP SDK, zod or SQLite), and every failure
 * is silent: exit 0 with nothing on stdout, so the client carries on unaffected.
 */
import { spawn } from "node:child_process";

import {
    BACKGROUND_WAIT_EVENT, HOOK_INPUT_FIELDS, HOOK_REQUEST_TIMEOUT_MS, HOOK_STOP_REQUEST_TIMEOUT_MS, WAIT_HOOK_TIMEOUT_SEC, noDaemonHint,
    isHookClient, type HookClient, type HookResponse
} from "../contract.js";
import { NexusClient, NexusTransportError, REQUEST_TIMEOUT_CODE } from "../client/nexus-client.js";
import { DISCOVER_ENDPOINT, LOCAL_ENDPOINT, resolveEndpoint } from "../client/discovery.js";

/** Errors after which a discovered daemon is looked up again: it was never reached, so resending is safe. */
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EADDRNOTAVAIL"]);

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
    const configured = argValue(argv, "--endpoint") || process.env.NEXUS_ENDPOINT || LOCAL_ENDPOINT;

    const stdin: unknown = JSON.parse(await readStdin());
    if (!isPlainObject(stdin)) throw new Error("hook input is not a JSON object");
    const input: Record<string, unknown> = {};
    for (const field of HOOK_INPUT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(stdin, field)) input[field] = stdin[field];
    }
    const timeoutMs = stdin.hook_event_name === "Stop" ? HOOK_STOP_REQUEST_TIMEOUT_MS : HOOK_REQUEST_TIMEOUT_MS;

    /** Send to `endpoint`; nothing listening there is reported with what to do about it. */
    const send = async (endpoint: string): Promise<HookResponse> => {
        try {
            return await new NexusClient({ endpoint }).hook({ client, input }, timeoutMs);
        } catch (error) {
            if (!(error instanceof NexusTransportError && error.code === "ECONNREFUSED")) throw error;
            throw new NexusTransportError(`No n2n-nexus-host at ${endpoint}. ${noDaemonHint(endpoint)}`, error.code);
        }
    };

    const endpoint = await resolveEndpoint(configured);
    let response: HookResponse;
    try {
        response = await send(endpoint);
    } catch (error) {
        // The cached daemon is gone: look again, and fall back to the local endpoint if none answers.
        // A timed-out Stop may have been waiting for messages on purpose, so only other events count a timeout.
        const code = error instanceof NexusTransportError ? error.code ?? "" : "";
        const unreachable = UNREACHABLE_CODES.has(code) || (code === REQUEST_TIMEOUT_CODE && stdin.hook_event_name !== "Stop");
        if (configured !== DISCOVER_ENDPOINT || !unreachable) throw error;
        const found = await resolveEndpoint(configured, { fresh: true });
        if (found === endpoint) throw error;
        response = await send(found);
    }

    if (!isPlainObject(response) || !("output" in response)) throw new Error("invalid response from n2n-nexus-host");
    const { output } = response;
    if (output === null) return "";
    if (!isPlainObject(output)) throw new Error("invalid output from n2n-nexus-host");
    return JSON.stringify(output) + "\n";
}

/** The background wait ends before the client's hook timeout would kill it during a request. */
const WAIT_DEADLINE_MS = (WAIT_HOOK_TIMEOUT_SEC - 10) * 1000;

/**
 * Ask the daemon until something arrives for the session (the notification
 * text), the session becomes active again or the deadline passes (null).
 */
export async function waitForWake(client: HookClient, sessionId: string, endpoint: string, deadlineMs = WAIT_DEADLINE_MS): Promise<string | null> {
    const nexus = new NexusClient({ endpoint });
    // Start a request only if it can run to its own timeout before the deadline.
    const deadline = Date.now() + deadlineMs - HOOK_STOP_REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const response = await nexus.hook({ client, input: { hook_event_name: BACKGROUND_WAIT_EVENT, session_id: sessionId } }, HOOK_STOP_REQUEST_TIMEOUT_MS);
        const output = isPlainObject(response) ? response.output : null;
        if (isPlainObject(output) && typeof output.wake === "string") return output.wake;
        if (!(isPlainObject(output) && output.timeout === true)) return null;
    }
    return null;
}

/**
 * `--wait`, started by a Stop hook when a turn ends. Claude runs it as an
 * asyncRewake hook: exit code 2 with the notification on stderr wakes the
 * conversation. Codex has no such hook, so its Stop hook starts a detached copy
 * (`--session <id>`) and returns at once; the copy hands the notification to
 * `codex queue` (NEXUS_CODEX_COMMAND, default `codex`), which starts a turn.
 */
async function runWait(argv: string[]): Promise<number> {
    const client = argv[0];
    if (!isHookClient(client)) throw new Error(`unknown client "${client ?? ""}" (expected claude or codex)`);
    // claude -p (unattended) waits for this hook before it exits, and nobody would see a woken turn.
    if (client === "claude" && process.env.CLAUDE_CODE_SESSION_ATTENDED === "0") return 0;
    const configured = argValue(argv, "--endpoint") || process.env.NEXUS_ENDPOINT || LOCAL_ENDPOINT;
    let sessionId = argValue(argv, "--session");
    if (!sessionId) {
        const stdin: unknown = JSON.parse(await readStdin());
        if (!isPlainObject(stdin) || typeof stdin.session_id !== "string" || !stdin.session_id) return 0;
        sessionId = stdin.session_id;
        if (client === "codex") {
            const { entryScript } = await import("./entry.js");
            const args = [entryScript(), "hook", "codex", "--wait", "--session", sessionId, ...(argValue(argv, "--endpoint") ? ["--endpoint", configured] : [])];
            spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
            return 0;
        }
    }
    const text = await waitForWake(client, sessionId, await resolveEndpoint(configured));
    if (text === null) return 0;
    if (client === "codex") {
        // Never through cmd.exe: the text comes from another session and spans several lines.
        const { spawnClientSync } = await import("./client-command.js");
        spawnClientSync(process.env.NEXUS_CODEX_COMMAND || "codex", ["queue", "--thread", sessionId, "--message", text], { stdio: "ignore", windowsHide: true });
        return 0;
    }
    await new Promise<void>((resolve) => process.stderr.write(text + "\n", () => resolve()));
    return 2;
}

/** Run the hook command; resolves to exit code 0, or 2 when a background wait wakes a Claude conversation. */
export async function runHook(argv: string[]): Promise<number> {
    if (argv.includes("--wait")) {
        try {
            return await runWait(argv);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[n2n-nexus] hook --wait: ${message.replace(/\s+/g, " ").slice(0, 300)}\n`);
            return 0;
        }
    }
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
