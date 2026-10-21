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
    PREVIEW_CHARS, TOOL_USE_BINDING_TTL_MS, type HookClient
} from "../src/daemon/hook-contract.js";
import { requestJson } from "./helpers/daemon.js";

type HookOutput = {
    decision?: string;
    reason?: string;
    hookSpecificOutput?: { hookEventName: string; additionalContext: string };
} | null;
type ToolReply<T> = { ok: boolean; result?: T; error?: string };

const LISTEN_MS = 300;

let port = 0;
let server: http.Server | null = null;
const previousRoot = process.env.NEXUS_ROOT;

async function start(options: { rateLimit?: RateLimitConfig; listenWaitMs?: number } = {}) {
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
        expect(blocked?.reason?.endsWith(`${MESSAGE_TRUST_NOTE} ${STOP_CLOSING}`)).toBe(true);
        expect(status("claude:r")).toBe("working");

        expect(await hook("claude", "Stop", "r", { stop_hook_active: true })).toBeNull();
        expect(status("claude:r")).toBe("idle");
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
        expect(payload.output).toEqual({ decision: "block", reason: `${NOTICE_PREFIX} Notices:\n- codex@proj#2 (codex:target) finished its turn.` });
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
