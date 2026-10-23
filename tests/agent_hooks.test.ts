import http from "node:http";
import { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonServer } from "../src/daemon/server.js";
import { closeDatabase, getDatabase } from "../src/storage/sqlite.js";
import { StorageManager } from "../src/storage/index.js";
import { AgentStore } from "../src/storage/agents.js";
import { RateLimitConfig } from "../src/daemon/rate-limit.js";
import {
    IDLE_SUBSCRIPTION_TTL_MS, MESSAGE_TRUST_NOTE, MESSAGE_TTL_MS, NOTICE_PREFIX, NOTIFY_CLOSING, NO_AGENT_SESSION_ERROR, STOP_CLOSING,
    BACKGROUND_WAIT_EVENT, PREVIEW_CHARS, SESSION_START_CLOSING, STALE_SESSION_MS, STATUS_NOTE, TOOL_USE_BINDING_TTL_MS, type HookClient
} from "../src/daemon/hook-contract.js";
import { requestJson } from "./helpers/daemon.js";

type HookOutput = {
    decision?: string;
    reason?: string;
    hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    wake?: string;
    timeout?: boolean;
} | null;
type ToolReply<T> = { ok: boolean; result?: T; error?: string };

const LISTEN_MS = 300;

let port = 0;
let server: http.Server | null = null;
const previousRoot = process.env.NEXUS_ROOT;

async function start(options: { rateLimit?: RateLimitConfig; listenWaitMs?: number; maxAutoTurns?: number } = {}) {
    const root = path.join(process.cwd(), "tests", "tmp", "agent-hooks");
    closeDatabase();
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    process.env.NEXUS_ROOT = root;
    StorageManager.resetInit();
    ({ server } = await createDaemonServer({ port: 0, version: "test", listenWaitMs: LISTEN_MS, ...options }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
}

afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
    }
    closeDatabase();
    if (previousRoot === undefined) delete process.env.NEXUS_ROOT;
    else process.env.NEXUS_ROOT = previousRoot;
});

const hookRaw = (client: HookClient, event: string, sessionId: string, extra: Record<string, unknown> = {}) =>
    requestJson<{ output?: HookOutput; ok?: boolean; error?: string }>(port, "POST", "/api/hook", {
        client, input: { hook_event_name: event, session_id: sessionId, cwd: "/work/proj", ...extra }
    });

async function hook(client: HookClient, event: string, sessionId: string, extra: Record<string, unknown> = {}): Promise<HookOutput> {
    const res = await hookRaw(client, event, sessionId, extra);
    expect(res.status).toBe(200);
    return res.payload.output ?? null;
}

let toolUseSeq = 0;
/** Call a tool as a Claude session: PreToolUse binds a fresh toolUseId first. */
async function claudeTool<T>(sessionId: string, tool: string, args: Record<string, unknown> = {}) {
    const toolUseId = `toolu_${++toolUseSeq}`;
    expect(await hook("claude", "PreToolUse", sessionId, { tool_use_id: toolUseId, tool_name: `mcp__n2n-nexus__${tool}` })).toBeNull();
    return requestJson<ToolReply<T>>(port, "POST", "/api/tools/call", { tool, args, instanceId: "i1", caller: { client: "claude", toolUseId } });
}

const claudeRead = (sessionId: string) => claudeTool(sessionId, "read");

const codexTool = <T>(sessionId: string, tool: string, args: Record<string, unknown> = {}) =>
    requestJson<ToolReply<T>>(port, "POST", "/api/tools/call", { tool, args, instanceId: "i2", caller: { client: "codex", sessionId } });

async function send(fromCodex: string, to: string, text: string, notifyWhenIdle = false): Promise<string> {
    const res = await codexTool<{ messageId: string }>(fromCodex, "send", { to, text, notifyWhenIdle });
    expect(res.status).toBe(200);
    return res.payload.result!.messageId;
}

const status = (id: string) => AgentStore.get(id)?.status;
const context = (out: HookOutput) => out?.hookSpecificOutput?.additionalContext ?? "";

/** Raw hook request that can be cancelled, as the client does by killing the hook. */
function openHook(client: HookClient, event: string, sessionId: string, extra: Record<string, unknown> = {}) {
    const data = JSON.stringify({ client, input: { hook_event_name: event, session_id: sessionId, ...extra } });
    let req!: http.ClientRequest;
    const response = new Promise<{ status: number; payload: { output: HookOutput } }>((resolve, reject) => {
        req = http.request({
            method: "POST", hostname: "127.0.0.1", port, path: "/api/hook",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
        }, (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => resolve({ status: res.statusCode || 0, payload: JSON.parse(raw) }));
        });
        req.on("error", reject);
        req.end(data);
    });
    return { response, cancel: () => req.destroy() };
}

async function until(predicate: () => boolean, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error("condition not reached");
        await new Promise((r) => setTimeout(r, 10));
    }
}

describe("POST /api/hook: sessions and names", () => {
    it("creates sessions named <client>@<cwd basename> with the smallest free #N among sessions that are not offline", async () => {
        await start();
        await hook("claude", "SessionStart", "a");
        await hook("claude", "SessionStart", "b");
        await hook("claude", "UserPromptSubmit", "c");                            // any event creates the session
        expect(AgentStore.get("claude:a")).toMatchObject({ client: "claude", name: "claude@proj", cwd: "/work/proj", status: "idle", note: "", listening: false });
        expect(AgentStore.get("claude:b")?.name).toBe("claude@proj#2");
        expect(AgentStore.get("claude:c")).toMatchObject({ name: "claude@proj#3", status: "working" });

        // No cwd: name falls back to "session", cwd is "".
        await requestJson(port, "POST", "/api/hook", { client: "codex", input: { hook_event_name: "SessionStart", session_id: "x" } });
        expect(AgentStore.get("codex:x")).toMatchObject({ name: "codex@session", cwd: "" });

        // An offline session's name is free again; when it comes back the name is taken, so it gets a new #N.
        await hook("claude", "SessionEnd", "a", { reason: "clear" });
        await hook("claude", "SessionStart", "d");
        expect(AgentStore.get("claude:d")?.name).toBe("claude@proj");
        await hook("claude", "SessionStart", "a", { source: "resume" });
        expect(AgentStore.get("claude:a")).toMatchObject({ name: "claude@proj#4", status: "idle" });

        // A session coming back whose name is still free keeps it.
        await hook("claude", "SessionEnd", "b");
        await hook("claude", "SessionStart", "b");
        expect(AgentStore.get("claude:b")?.name).toBe("claude@proj#2");
    });

    it("ignores input without a session id, rejects malformed requests and refreshes last activity on every event", async () => {
        await start();
        for (const input of [{ hook_event_name: "SessionStart" }, { hook_event_name: "SessionStart", session_id: "" }, { hook_event_name: "Stop", session_id: 7 }]) {
            const res = await requestJson<{ output: HookOutput }>(port, "POST", "/api/hook", { client: "claude", input });
            expect(res).toEqual({ status: 200, payload: { output: null } });
        }
        expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM agent_sessions").get()).toEqual({ n: 0 });

        expect((await requestJson(port, "POST", "/api/hook", { client: "cursor", input: { session_id: "a" } })).status).toBe(400);
        expect((await requestJson(port, "POST", "/api/hook", { client: "claude" })).status).toBe(400);

        const t0 = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(t0);
        await hook("claude", "SessionStart", "a");
        expect(AgentStore.get("claude:a")?.lastActiveAt).toBe(new Date(t0).toISOString());
        vi.spyOn(Date, "now").mockReturnValue(t0 + 5000);
        await hook("claude", "PreToolUse", "a", { tool_use_id: "toolu_x" });
        expect(AgentStore.get("claude:a")?.lastActiveAt).toBe(new Date(t0 + 5000).toISOString());
        expect(status("claude:a")).toBe("idle");                                 // PreToolUse does not change the status
        expect(await hook("claude", "UnknownEvent", "a")).toBeNull();
    });

    it("SessionEnd sets offline, turns listening off and prints nothing", async () => {
        await start();
        await hook("codex", "SessionStart", "a");
        expect((await codexTool("a", "listen", { on: true })).payload.result).toEqual({ listening: true });
        expect(await hook("codex", "SessionEnd", "a", { reason: "exit" })).toBeNull();
        expect(AgentStore.get("codex:a")).toMatchObject({ status: "offline", listening: false });
    });
});

describe("POST /api/hook: SessionStart introduction", () => {
    it("tells a new session who it is and which sessions are online, at most five individually", async () => {
        await start();
        const alone = context(await hook("claude", "SessionStart", "a"));
        expect(alone.startsWith(`${NOTICE_PREFIX} This conversation is claude@proj (claude:a) on n2n-nexus`)).toBe(true);
        expect(alone).toContain("No other AI sessions are online.");
        expect(alone).toContain(SESSION_START_CLOSING);

        await hook("codex", "SessionStart", "b");
        await codexTool("b", "set_profile", { note: "fixing login" });
        for (const id of ["c", "d", "e", "f", "g"]) await hook("codex", "SessionStart", id);
        await hook("codex", "SessionEnd", "g");                                  // offline sessions are not listed

        const text = context(await hook("claude", "SessionStart", "h"));
        expect(text).toContain("6 other AI sessions are online:");
        expect(text).toContain("- codex@proj (codex:b), codex, idle, /work/proj: fixing login");
        expect(text).not.toContain("(codex:g)");
        expect(text).toContain("This conversation is claude@proj#2 (claude:h)");
        expect(text).not.toContain("- claude@proj#2 (claude:h)");              // not listed among the others
        expect(text).toContain("...and 1 more");
        expect(text.endsWith(SESSION_START_CLOSING)).toBe(true);
        expect(text).toContain(STATUS_NOTE);
        expect(status("claude:h")).toBe("idle");
    });

    it("counts idle and working sessions without activity for STALE_SESSION_MS as offline until they are active again", async () => {
        await start();
        const t0 = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(t0);
        await hook("codex", "SessionStart", "idle");
        await hook("codex", "UserPromptSubmit", "busy");
        await hook("codex", "SessionStart", "waiting");
        expect((await codexTool("waiting", "listen", { on: true })).status).toBe(200);
        AgentStore.setStatus("codex:waiting", "listening");                     // a Stop hook is waiting for messages

        vi.spyOn(Date, "now").mockReturnValue(t0 + STALE_SESSION_MS + 1000);
        const text = context(await hook("claude", "SessionStart", "new"));
        expect(status("codex:idle")).toBe("offline");
        expect(status("codex:busy")).toBe("offline");
        expect(status("codex:waiting")).toBe("listening");
        expect(text).toContain("1 other AI session is online:");
        expect(text).toContain("(codex:waiting)");

        // Any event brings a session back, a direct-message tool call or Claude's PreToolUse included.
        await hook("codex", "UserPromptSubmit", "idle");
        expect(status("codex:idle")).toBe("working");
        const peers = await codexTool<{ self: { status: string } }>("busy", "peers");
        expect(peers.payload.result?.self.status).toBe("working");
        await hook("claude", "SessionStart", "quiet");
        vi.spyOn(Date, "now").mockReturnValue(t0 + 2 * STALE_SESSION_MS + 2000);
        await hook("codex", "UserPromptSubmit", "idle");                           // expires claude:quiet
        expect(status("claude:quiet")).toBe("offline");
        await hook("claude", "PreToolUse", "quiet", { tool_use_id: "toolu_quiet" });
        expect(status("claude:quiet")).toBe("working");
    });
});

describe("POST /api/hook: notifications", () => {
    it("UserPromptSubmit lists unread messages and pending notices, at most five individually, with first-line previews", async () => {
        await start();
        await hook("codex", "SessionStart", "sender");
        await hook("claude", "SessionStart", "rcv");
        expect(await hook("claude", "UserPromptSubmit", "rcv")).toBeNull();      // nothing to tell

        const long = "x".repeat(PREVIEW_CHARS + 50);
        await send("sender", "claude:rcv", `${long}\nsecond line`);
        for (let i = 2; i <= 7; i++) await send("sender", "claude:rcv", `message ${i}`);

        const out = await hook("claude", "UserPromptSubmit", "rcv");
        expect(out?.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
        const text = context(out);
        expect(text.startsWith(`${NOTICE_PREFIX} 7 unread direct messages:`)).toBe(true);
        expect(text).toContain(`From codex@proj (codex:sender) at `);
        expect(text).toContain(`: ${"x".repeat(PREVIEW_CHARS)}\n`);
        expect(text).not.toContain("x".repeat(PREVIEW_CHARS + 1));
        expect(text).not.toContain("second line");
        expect(text).toContain("message 5");
        expect(text).not.toContain("message 6");
        expect(text).toContain("...and 2 more");
        expect(text).toContain(`${MESSAGE_TRUST_NOTE} ${NOTIFY_CLOSING}`);
        expect(status("claude:rcv")).toBe("working");

        // Every unread message was marked notified, so a tool call adds nothing.
        expect(await hook("claude", "PostToolUse", "rcv")).toBeNull();
        // The next prompt still lists them while they are unread.
        expect(context(await hook("claude", "UserPromptSubmit", "rcv"))).toContain("7 unread direct messages");
    });

    it("lists notices alone without the message note", async () => {
        await start();
        await hook("codex", "SessionStart", "watcher");
        await hook("codex", "SessionStart", "target");
        await send("watcher", "codex:target", "ping", true);
        await codexTool("target", "read");
        await hook("codex", "Stop", "target");

        const text = context(await hook("codex", "UserPromptSubmit", "watcher"));
        expect(text).toBe(`${NOTICE_PREFIX} Notices:\n- codex@proj#2 (codex:target) finished its turn.`);
        expect(await hook("codex", "UserPromptSubmit", "watcher")).toBeNull();   // notices are delivered once
    });

    it("PostToolUse reports only what was not notified yet", async () => {
        await start();
        await hook("codex", "SessionStart", "s");
        await hook("claude", "SessionStart", "r");
        await send("s", "claude:r", "first");
        const first = await hook("claude", "PostToolUse", "r", { tool_use_id: "t1", tool_name: "Bash" });
        expect(first?.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
        expect(context(first)).toContain(`${NOTICE_PREFIX} 1 new direct message:`);
        expect(context(first)).toContain("first");
        expect(status("claude:r")).toBe("working");

        expect(await hook("claude", "PostToolUse", "r")).toBeNull();

        await send("s", "claude:r", "second");
        const second = context(await hook("claude", "PostToolUse", "r"));
        expect(second).toContain("second");
        expect(second).not.toContain("first");
    });

    it("Stop blocks once while anything is unread, then lets the turn end", async () => {
        await start();
        await hook("codex", "SessionStart", "s");
        await hook("claude", "SessionStart", "r");
        expect(await hook("claude", "Stop", "r", { stop_hook_active: false })).toBeNull();
        expect(status("claude:r")).toBe("idle");

        await send("s", "claude:r", "please look");
        await hook("claude", "UserPromptSubmit", "r");                           // already notified: Stop still blocks
        const blocked = await hook("claude", "Stop", "r", { stop_hook_active: false });
        expect(blocked?.decision).toBe("block");
        expect(blocked?.reason?.startsWith(`${NOTICE_PREFIX} 1 unread direct message:`)).toBe(true);
        expect(blocked?.reason).toContain("please look");
        // Continuing a turn that was about to end asks for read and reply, not just a look.
        expect(blocked?.reason).toContain(`${MESSAGE_TRUST_NOTE} ${STOP_CLOSING}\n${NOTICE_PREFIX} Automatic turn 1 of 8`);
        expect(status("claude:r")).toBe("working");

        expect(await hook("claude", "Stop", "r", { stop_hook_active: true })).toBeNull();
        expect(status("claude:r")).toBe("idle");
    });
});

describe("POST /api/hook: background wait", () => {
    it("shows the session as listening and returns a new message as soon as it arrives", async () => {
        await start({ listenWaitMs: 5000 });
        await hook("codex", "SessionStart", "s");
        await hook("claude", "SessionStart", "r");
        await hook("claude", "Stop", "r", { stop_hook_active: false });
        const waiting = openHook("claude", BACKGROUND_WAIT_EVENT, "r");
        await until(() => status("claude:r") === "listening");
        await send("s", "claude:r", "wake up");
        const { payload } = await waiting.response;
        expect(payload.output?.wake).toContain(`${NOTICE_PREFIX} 1 new direct message:`);
        expect(payload.output?.wake).toContain("wake up");
        expect(status("claude:r")).toBe("working");
        expect(await hook("claude", "UserPromptSubmit", "r")).not.toBeNull();     // still unread until read
    });

    it("waits while the turn is still ending, and Stop keeps the session listening", async () => {
        await start({ listenWaitMs: 5000 });
        await hook("codex", "SessionStart", "s");
        await hook("codex", "UserPromptSubmit", "r");
        await send("s", "codex:r", "before the turn ended");
        const waiting = openHook("codex", BACKGROUND_WAIT_EVENT, "r");          // started alongside Stop
        await new Promise((r) => setTimeout(r, 100));
        expect(status("codex:r")).toBe("working");

        // Stop announces the unread message itself; the wait must not repeat it.
        expect((await hook("codex", "Stop", "r", { stop_hook_active: false }))?.decision).toBe("block");
        expect(await hook("codex", "Stop", "r", { stop_hook_active: true })).toBeNull();
        expect(status("codex:r")).toBe("listening");
        await send("s", "codex:r", "after");
        const { payload } = await waiting.response;
        expect(payload.output?.wake).toContain("after");
        expect(payload.output?.wake).not.toContain("before the turn ended");
    });

    it("ends without output when the session becomes active, times out or the client goes away", async () => {
        await start();
        await hook("claude", "SessionStart", "r");
        await hook("claude", "Stop", "r");

        const cancelled = openHook("claude", BACKGROUND_WAIT_EVENT, "r");
        await until(() => status("claude:r") === "listening");
        await hook("claude", "UserPromptSubmit", "r");
        expect((await cancelled.response).payload.output).toBeNull();
        expect(status("claude:r")).toBe("working");

        await hook("claude", "Stop", "r");
        const timedOut = openHook("claude", BACKGROUND_WAIT_EVENT, "r");
        expect((await timedOut.response).payload.output).toEqual({ timeout: true });
        expect(status("claude:r")).toBe("idle");

        const gone = openHook("claude", BACKGROUND_WAIT_EVENT, "r");
        await until(() => status("claude:r") === "listening");
        gone.cancel();
        await gone.response.catch(() => { });
        await until(() => status("claude:r") === "idle");
    });

    it("leaves delivery to a listening Stop hook while it waits, and takes over when that wait ends", async () => {
        await start();
        await hook("codex", "SessionStart", "s");
        await hook("codex", "UserPromptSubmit", "r");
        await codexTool("r", "listen", { on: true });
        const background = openHook("codex", BACKGROUND_WAIT_EVENT, "r");      // registered first
        const listening = openHook("codex", "Stop", "r", { stop_hook_active: false });
        await until(() => status("codex:r") === "listening");
        await send("s", "codex:r", "for the listening stop");
        const stop = (await listening.response).payload.output;
        expect(stop?.decision).toBe("block");
        expect(stop?.reason).toContain("for the listening stop");

        expect((await background.response).payload.output).toEqual({ timeout: true });   // it did not take the message

        // The next listening Stop times out (LISTEN_MS); the client's next background wait delivers what arrives then.
        await hook("codex", "Stop", "r", { stop_hook_active: true });
        const again = openHook("codex", BACKGROUND_WAIT_EVENT, "r");
        await until(() => status("codex:r") === "listening");
        await send("s", "codex:r", "for the background wait");
        const { payload } = await again.response;
        expect(payload.output?.wake).toContain("for the background wait");
        expect(payload.output?.wake).not.toContain("for the listening stop");
    });

    it("with listen on, leaves listening once neither a background wait nor a listening Stop is pending", async () => {
        await start();
        await hook("codex", "SessionStart", "r");
        await codexTool("r", "listen", { on: true });
        expect(await hook("codex", "Stop", "r", { stop_hook_active: true })).toBeNull();   // listening Stop times out
        expect(status("codex:r")).toBe("idle");
        const background = openHook("codex", BACKGROUND_WAIT_EVENT, "r");
        await until(() => status("codex:r") === "listening");
        expect((await background.response).payload.output).toEqual({ timeout: true });
        expect(status("codex:r")).toBe("idle");             // the client asks no more: it can go stale
    });

    it("a background wait counts as activity, so the session does not go stale between two waits", async () => {
        await start();
        const t0 = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(t0);
        await hook("codex", "SessionStart", "r");
        await hook("codex", "Stop", "r", { stop_hook_active: false });

        vi.spyOn(Date, "now").mockReturnValue(t0 + STALE_SESSION_MS + 1000);
        const background = openHook("codex", BACKGROUND_WAIT_EVENT, "r");
        expect((await background.response).payload.output).toEqual({ timeout: true });
        expect(status("codex:r")).toBe("idle");
        await hook("claude", "SessionStart", "other");         // any event expires stale sessions before the next wait
        expect(status("codex:r")).toBe("idle");
    });

    it("never runs for an unknown session", async () => {
        await start();
        expect(await hook("claude", BACKGROUND_WAIT_EVENT, "nobody")).toBeNull();
    });
});

describe("POST /api/hook: automatic turn limit", () => {
    /** The woken turn as the client runs it: its prompt, then the end of the turn. */
    async function wokenTurn(client: HookClient, sessionId: string) {
        await hook(client, "UserPromptSubmit", sessionId);
        await hook(client, "Stop", sessionId, { stop_hook_active: false });
    }

    it("wakes at most maxAutoTurns times until the user prompts; the woken turn's own prompt does not count", async () => {
        await start({ listenWaitMs: 2000, maxAutoTurns: 2 });
        await hook("codex", "SessionStart", "s");
        await hook("claude", "SessionStart", "r");
        await hook("claude", "Stop", "r", { stop_hook_active: false });

        for (const n of [1, 2]) {
            const waiting = openHook("claude", BACKGROUND_WAIT_EVENT, "r");
            await until(() => status("claude:r") === "listening");
            await send("s", "claude:r", `ping ${n}`);
            const wake = (await waiting.response).payload.output?.wake ?? "";
            expect(wake).toContain(`ping ${n}`);
            expect(wake).toContain(`Automatic turn ${n} of 2`);
            await claudeRead("r");
            await wokenTurn("claude", "r");
        }

        // The limit is reached: the wait ends at once and the message only waits, unread and not announced.
        const third = openHook("claude", BACKGROUND_WAIT_EVENT, "r");
        expect((await third.response).payload.output).toBeNull();
        expect(status("claude:r")).toBe("idle");
        await send("s", "claude:r", "ping 3");
        expect(AgentStore.unread("claude:r", true)).toHaveLength(1);

        // A real prompt (no wake just before it) starts counting again and announces the message.
        expect(context(await hook("claude", "UserPromptSubmit", "r"))).toContain("ping 3");
        await claudeRead("r");
        await hook("claude", "Stop", "r", { stop_hook_active: false });
        const again = openHook("claude", BACKGROUND_WAIT_EVENT, "r");
        await until(() => status("claude:r") === "listening");
        await send("s", "claude:r", "ping 4");
        expect((await again.response).payload.output?.wake).toContain("Automatic turn 1 of 2");
    });

    it("counts a Stop held open for unread messages, and lets the turn end once the limit is reached", async () => {
        await start({ maxAutoTurns: 1 });
        await hook("codex", "SessionStart", "s");
        await hook("codex", "UserPromptSubmit", "r");
        await send("s", "codex:r", "first");
        const blocked = await hook("codex", "Stop", "r", { stop_hook_active: false });
        expect(blocked?.decision).toBe("block");
        expect(blocked?.reason).toContain("Automatic turn 1 of 1");

        await send("s", "codex:r", "second");
        expect(await hook("codex", "Stop", "r", { stop_hook_active: false })).toBeNull();
        expect(status("codex:r")).toBe("idle");
    });

    it("ends a listening Stop hook without delivering once the limit is reached", async () => {
        await start({ maxAutoTurns: 1 });
        await hook("codex", "SessionStart", "s");
        await hook("codex", "SessionStart", "r");
        await codexTool("r", "listen", { on: true });
        const first = openHook("codex", "Stop", "r", { stop_hook_active: false });
        await until(() => status("codex:r") === "listening");
        await send("s", "codex:r", "one");
        expect((await first.response).payload.output?.reason).toContain("Automatic turn 1 of 1");

        const second = await hook("codex", "Stop", "r", { stop_hook_active: true });
        expect(second).toBeNull();
        expect(status("codex:r")).toBe("idle");
    });

    it("never limits with maxAutoTurns 0 and adds no turn count", async () => {
        await start({ maxAutoTurns: 0 });
        await hook("codex", "SessionStart", "s");
        await hook("codex", "UserPromptSubmit", "r");
        for (let i = 0; i < 3; i++) {
            await send("s", "codex:r", `m${i}`);
            const out = await hook("codex", "Stop", "r", { stop_hook_active: false });
            expect(out?.decision).toBe("block");
            expect(out?.reason).not.toContain("Automatic turn");
            await codexTool("r", "read");
        }
    });
});

describe("POST /api/hook: listen mode", () => {
    it("wakes a listening session as soon as a new message arrives", async () => {
        await start();
        await hook("codex", "SessionStart", "s");
        await hook("codex", "SessionStart", "r");
        await codexTool("r", "listen", { on: true });

        const startedAt = Date.now();
        const waiting = openHook("codex", "Stop", "r", { stop_hook_active: false });
        await until(() => status("codex:r") === "listening");
        await send("s", "codex:r", "wake up");
        const { payload } = await waiting.response;
        expect(Date.now() - startedAt).toBeLessThan(LISTEN_MS);
        expect(payload.output?.decision).toBe("block");
        expect(payload.output?.reason).toContain(`${NOTICE_PREFIX} 1 new direct message:`);
        expect(payload.output?.reason).toContain("wake up");
        expect(status("codex:r")).toBe("working");
    });

    it("times out to idle, and messages already notified do not wake it", async () => {
        await start();
        await hook("codex", "SessionStart", "s");
        await hook("codex", "SessionStart", "r");
        await codexTool("r", "listen", { on: true });

        expect(await hook("codex", "Stop", "r")).toBeNull();
        expect(status("codex:r")).toBe("idle");

        await send("s", "codex:r", "old news");
        await hook("codex", "UserPromptSubmit", "r");
        const startedAt = Date.now();
        expect(await hook("codex", "Stop", "r", { stop_hook_active: true })).toBeNull();
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(LISTEN_MS - 20);
        expect(status("codex:r")).toBe("idle");
    });

    it("returns immediately with what arrived but was not notified before the wait began", async () => {
        await start();
        await hook("codex", "SessionStart", "s");
        await hook("codex", "SessionStart", "r");
        await codexTool("r", "listen", { on: true });
        await send("s", "codex:r", "during continuation");
        const out = await hook("codex", "Stop", "r", { stop_hook_active: true });
        expect(out?.reason).toContain("during continuation");
        expect(status("codex:r")).toBe("working");
    });

    it("is woken by a notice, such as a notifyWhenIdle target finishing its turn", async () => {
        await start();
        await hook("codex", "SessionStart", "watcher");
        await hook("codex", "SessionStart", "target");
        await send("watcher", "codex:target", "do it", true);
        await codexTool("watcher", "listen", { on: true });
        const waiting = openHook("codex", "Stop", "watcher");
        await until(() => status("codex:watcher") === "listening");

        await codexTool("target", "read");
        expect(await hook("codex", "Stop", "target")).toBeNull();
        const { payload } = await waiting.response;
        expect(payload.output?.decision).toBe("block");
        expect(payload.output?.reason?.startsWith(`${NOTICE_PREFIX} Notices:\n- codex@proj#2 (codex:target) finished its turn.\n${NOTICE_PREFIX} Automatic turn 1 of 8`)).toBe(true);
    });

    it("cancels the wait and goes idle when the hook's client disconnects", async () => {
        // A long wait, so going idle can only come from the disconnect, not from the timeout.
        await start({ listenWaitMs: 60_000 });
        await hook("claude", "SessionStart", "r");
        await claudeTool("r", "listen", { on: true });
        const waiting = openHook("claude", "Stop", "r");
        waiting.response.catch(() => undefined);
        await until(() => status("claude:r") === "listening");
        waiting.cancel();
        await until(() => status("claude:r") === "idle");
    });

    it("ends the wait when the conversation ends, and a later message leaves it offline", async () => {
        await start({ listenWaitMs: 60_000 });
        await hook("claude", "SessionStart", "se");
        await hook("codex", "SessionStart", "sender");
        await claudeTool("se", "listen", { on: true });
        const waiting = openHook("claude", "Stop", "se");
        await until(() => status("claude:se") === "listening");
        expect(await hook("claude", "SessionEnd", "se")).toBeNull();
        expect((await waiting.response).payload).toEqual({ output: null });
        await send("sender", "claude:se", "after the end");
        expect(status("claude:se")).toBe("offline");
        const row = getDatabase().prepare("SELECT notified_at FROM agent_messages WHERE to_id = ?").get("claude:se") as { notified_at: string | null };
        expect(row.notified_at).toBeNull();
    });

    it("ends the wait at once when the session turns listen off", async () => {
        await start({ listenWaitMs: 30_000 });
        await hook("claude", "SessionStart", "off");
        await claudeTool("off", "listen", { on: true });
        const waiting = openHook("claude", "Stop", "off");
        await until(() => status("claude:off") === "listening");
        const started = Date.now();
        expect((await claudeTool("off", "listen", { on: false })).payload.result).toEqual({ listening: false });
        expect((await waiting.response).payload).toEqual({ output: null });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(status("claude:off")).toBe("idle");
    });

    it("resets sessions left listening by a previous daemon, so they can go stale", async () => {
        await start();
        await hook("codex", "SessionStart", "r");
        AgentStore.setListening("codex:r", true);
        AgentStore.setStatus("codex:r", "listening");
        server!.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        closeDatabase();
        StorageManager.resetInit();
        ({ server } = await createDaemonServer({ port: 0, version: "test", listenWaitMs: LISTEN_MS }));
        expect(status("codex:r")).toBe("idle");
        expect(AgentStore.get("codex:r")?.listening).toBe(true);
    });

    it("lets the daemon shut down without waiting for a listening Stop hook", async () => {
        await start({ listenWaitMs: 60_000 });
        await hook("claude", "SessionStart", "sd");
        await claudeTool("sd", "listen", { on: true });
        const waiting = openHook("claude", "Stop", "sd");
        await until(() => status("claude:sd") === "listening");
        const started = Date.now();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
        expect(Date.now() - started).toBeLessThan(1000);
        expect((await waiting.response).payload).toEqual({ output: null });
    });
});

describe("POST /api/hook: idle subscriptions and expiry", () => {
    it("notifies a subscriber once when the target ends its turn, starts listening or goes offline", async () => {
        await start();
        await hook("codex", "SessionStart", "w");
        await hook("claude", "SessionStart", "t");

        await send("w", "claude:t", "task", true);
        await claudeTool("t", "read");
        await hook("claude", "Stop", "t");
        expect(context(await hook("codex", "UserPromptSubmit", "w"))).toContain("claude@proj (claude:t) finished its turn.");
        await hook("claude", "Stop", "t");                                       // the subscription was one-shot
        expect(await hook("codex", "UserPromptSubmit", "w")).toBeNull();

        // Entering listen mode counts as finishing the turn.
        await send("w", "claude:t", "task 2", true);
        await claudeTool("t", "read");
        await claudeTool("t", "listen", { on: true });
        expect(await hook("claude", "Stop", "t")).toBeNull();                    // waits LISTEN_MS, then idle
        expect(context(await hook("codex", "UserPromptSubmit", "w"))).toContain("finished its turn.");

        await send("w", "claude:t", "task 3", true);
        await hook("claude", "SessionEnd", "t");
        expect(context(await hook("codex", "UserPromptSubmit", "w"))).toContain("claude@proj (claude:t) went offline.");
    });

    it("drops subscriptions older than IDLE_SUBSCRIPTION_TTL_MS without a notice", async () => {
        await start();
        await hook("codex", "SessionStart", "w");
        await hook("codex", "SessionStart", "t");
        await send("w", "codex:t", "task", true);
        await codexTool("t", "read");
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + IDLE_SUBSCRIPTION_TTL_MS + 1000);
        await hook("codex", "Stop", "t");
        expect(await hook("codex", "UserPromptSubmit", "w")).toBeNull();
        expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM agent_idle_subscriptions").get()).toEqual({ n: 0 });
    });

    it("expires unread messages after MESSAGE_TTL_MS and tells the sender", async () => {
        await start();
        await hook("codex", "SessionStart", "s");
        await hook("claude", "SessionStart", "r");
        const messageId = await send("s", "claude:r", "stale request\nmore");
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + MESSAGE_TTL_MS + 1000);

        await hook("codex", "SessionStart", "other");                            // any hook runs the expiry check
        expect(getDatabase().prepare("SELECT status FROM agent_messages WHERE id = ?").get(messageId)).toEqual({ status: "expired" });
        expect(context(await hook("codex", "UserPromptSubmit", "s")))
            .toBe(`${NOTICE_PREFIX} Notices:\n- Your message to claude@proj (claude:r) expired unread: "stale request"`);
        expect(await hook("claude", "UserPromptSubmit", "r")).toBeNull();
        expect((await claudeTool<{ messages: unknown[] }>("r", "read")).payload.result?.messages).toEqual([]);
    });
});

describe("POST /api/hook: Claude tool-use bindings and rate limits", () => {
    it("resolves a Claude tool call through the PreToolUse binding until it expires", async () => {
        await start();
        await hook("claude", "SessionStart", "a");
        expect(await hook("claude", "PreToolUse", "a", { tool_use_id: "toolu_1" })).toBeNull();
        const call = (toolUseId: string) => requestJson<ToolReply<{ self: { id: string } }>>(port, "POST", "/api/tools/call", {
            tool: "peers", args: {}, caller: { client: "claude", toolUseId }
        });
        expect((await call("toolu_1")).payload.result?.self.id).toBe("claude:a");
        expect(await call("toolu_unknown")).toEqual({ status: 400, payload: { ok: false, error: NO_AGENT_SESSION_ERROR } });

        // A PreToolUse without tool_use_id binds nothing.
        await hook("claude", "PreToolUse", "a");
        expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM tool_use_bindings").get()).toEqual({ n: 1 });

        vi.spyOn(Date, "now").mockReturnValue(Date.now() + TOOL_USE_BINDING_TTL_MS + 1000);
        expect(await call("toolu_1")).toEqual({ status: 400, payload: { ok: false, error: NO_AGENT_SESSION_ERROR } });
        expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM tool_use_bindings").get()).toEqual({ n: 0 });
    });

    it("counts hooks only per address, never against an instance", async () => {
        // Burst 2 per instance, 10 per address; tokens do not come back during the test.
        await start({ rateLimit: { perSecond: 0.001, burst: 2 } });
        const tool = () => requestJson(port, "POST", "/api/tools/call", { tool: "list_meetings", args: {}, instanceId: "busy" });
        expect((await tool()).status).toBe(200);
        expect((await tool()).status).toBe(200);
        expect((await tool()).status).toBe(429);                                 // instance exhausted (3 of 10 address tokens)
        for (let i = 0; i < 7; i++) expect((await hookRaw("claude", "PostToolUse", "a")).status).toBe(200);
        expect((await hookRaw("claude", "PostToolUse", "a")).status).toBe(429); // address exhausted
    });
});
