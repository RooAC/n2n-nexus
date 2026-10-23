// POST /api/hook with a short listening wait (LISTEN_MS): session naming, introductions,
// notifications, background waits and listen mode where a wait runs out.
// Waits that must not run out are in agent_listen.test.ts; time travel in agent_clock.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { HOOK, until, useHost, type ToolReply } from "./harness.js";
import {
    BACKGROUND_WAIT_EVENT, MESSAGE_TRUST_NOTE, NOTICE_PREFIX, NOTIFY_CLOSING, NO_AGENT_SESSION_ERROR, SESSION_START_CLOSING, STATUS_NOTE, STOP_CLOSING,
    agentKit, context, ids
} from "./agents.js";

const LISTEN_MS = 300;
const PREVIEW_CHARS = HOOK.limits.previewChars;

const host = useHost({ listenWaitMs: LISTEN_MS, rateLimit: 0 });
const { hook, openHook, claudeTool, codexTool, send, sessions, profile, status, endSessions } = agentKit(host);
afterEach(() => endSessions());

describe("POST /api/hook: sessions and names", () => {
    it("creates sessions named <client>@<cwd basename> with the smallest free #N among sessions that are not offline", async () => {
        const s = ids();
        await hook("claude", "SessionStart", s("a"));
        await hook("claude", "SessionStart", s("b"));
        await hook("claude", "UserPromptSubmit", s("c"));                       // any event creates the session
        expect(await profile(`claude:${s("a")}`)).toMatchObject({ client: "claude", name: "claude@proj", cwd: "/work/proj", status: "idle", note: "" });
        expect((await profile(`claude:${s("b")}`))?.name).toBe("claude@proj#2");
        expect(await profile(`claude:${s("c")}`)).toMatchObject({ name: "claude@proj#3", status: "working" });

        // No cwd: name falls back to "session", cwd is "".
        await hook("codex", "SessionStart", s("x"), { cwd: undefined });
        expect(await profile(`codex:${s("x")}`)).toMatchObject({ name: "codex@session", cwd: "" });

        // An offline session's name is free again; when it comes back the name is taken, so it gets a new #N.
        await hook("claude", "SessionEnd", s("a"), { reason: "clear" });
        await hook("claude", "SessionStart", s("d"));
        expect((await profile(`claude:${s("d")}`))?.name).toBe("claude@proj");
        await hook("claude", "SessionStart", s("a"), { source: "resume" });
        expect(await profile(`claude:${s("a")}`)).toMatchObject({ name: "claude@proj#4", status: "idle" });

        // A session coming back whose name is still free keeps it.
        await hook("claude", "SessionEnd", s("b"));
        await hook("claude", "SessionStart", s("b"));
        expect((await profile(`claude:${s("b")}`))?.name).toBe("claude@proj#2");
    });

    it("ignores input without a session id, rejects malformed requests and leaves PreToolUse and unknown events without output", async () => {
        const s = ids();
        const before = (await sessions()).map((p) => p.id).sort();
        for (const input of [{ hook_event_name: "SessionStart" }, { hook_event_name: "SessionStart", session_id: "" }, { hook_event_name: "Stop", session_id: 7 }]) {
            const res = await host.request<{ output: unknown }>("POST", "/api/hook", { client: "claude", input });
            expect(res.status).toBe(200);
            expect(res.payload).toEqual({ output: null });
        }
        expect((await sessions()).map((p) => p.id).sort()).toEqual(before);      // no session was created

        const cursor = await host.request<{ ok: boolean; error: string }>("POST", "/api/hook", { client: "cursor", input: { session_id: "a" } });
        expect(cursor.status).toBe(400);
        expect(cursor.payload).toEqual({ ok: false, error: expect.any(String) });
        expect((await host.request("POST", "/api/hook", { client: "claude" })).status).toBe(400);
        expect((await host.request("POST", "/api/hook", { input: { session_id: "a" } })).status).toBe(400);

        await hook("claude", "SessionStart", s("a"));
        expect(await hook("claude", "PreToolUse", s("a"), { tool_use_id: `toolu_x_${s("a")}` })).toBeNull();
        expect(await status(`claude:${s("a")}`)).toBe("idle");                   // PreToolUse does not change the status
        expect(await hook("claude", "UnknownEvent", s("a"))).toBeNull();
    });

    it("SessionEnd sets offline and prints nothing", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("a"));
        expect((await codexTool(s("a"), "listen", { on: true })).payload.result).toEqual({ listening: true });
        expect(await hook("codex", "SessionEnd", s("a"), { reason: "exit" })).toBeNull();
        expect(await status(`codex:${s("a")}`)).toBe("offline");
    });
});

describe("POST /api/hook: SessionStart introduction", () => {
    it("tells a new session who it is and which sessions are online, at most five individually", async () => {
        const s = ids();
        const alone = context(await hook("claude", "SessionStart", s("a")));
        expect(alone.startsWith(`${NOTICE_PREFIX} This conversation is claude@proj (claude:${s("a")}) on n2n-nexus`)).toBe(true);
        expect(alone).toContain("No other AI sessions are online.");
        expect(alone).toContain(SESSION_START_CLOSING);

        await hook("codex", "SessionStart", s("b"));
        await codexTool(s("b"), "set_profile", { note: "fixing login" });
        for (const id of ["c", "d", "e", "f", "g"]) await hook("codex", "SessionStart", s(id));
        await hook("codex", "SessionEnd", s("g"));                               // offline sessions are not listed

        const text = context(await hook("claude", "SessionStart", s("h")));
        expect(text).toContain("6 other AI sessions are online:");
        expect(text).toContain(`- codex@proj (codex:${s("b")}), codex, idle, /work/proj: fixing login`);
        expect(text).not.toContain(`(codex:${s("g")})`);
        expect(text).toContain(`This conversation is claude@proj#2 (claude:${s("h")})`);
        expect(text).not.toContain(`- claude@proj#2 (claude:${s("h")})`);      // not listed among the others
        expect(text).toContain("...and 1 more");
        expect(text.endsWith(SESSION_START_CLOSING)).toBe(true);
        expect(text).toContain(STATUS_NOTE);
        expect(await status(`claude:${s("h")}`)).toBe("idle");
    });
});

describe("POST /api/hook: notifications", () => {
    it("UserPromptSubmit lists unread messages and pending notices, at most five individually, with first-line previews", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("sender"));
        await hook("claude", "SessionStart", s("rcv"));
        expect(await hook("claude", "UserPromptSubmit", s("rcv"))).toBeNull();  // nothing to tell

        const long = "x".repeat(PREVIEW_CHARS + 50);
        await send(s("sender"), `claude:${s("rcv")}`, `${long}\nsecond line`);
        for (let i = 2; i <= 7; i++) await send(s("sender"), `claude:${s("rcv")}`, `message ${i}`);

        const out = await hook("claude", "UserPromptSubmit", s("rcv"));
        expect(out?.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
        const text = context(out);
        expect(text.startsWith(`${NOTICE_PREFIX} 7 unread direct messages:`)).toBe(true);
        expect(text).toContain(`From codex@proj (codex:${s("sender")}) at `);
        expect(text).toContain(`: ${"x".repeat(PREVIEW_CHARS)}\n`);
        expect(text).not.toContain("x".repeat(PREVIEW_CHARS + 1));
        expect(text).not.toContain("second line");
        expect(text).toContain("message 5");
        expect(text).not.toContain("message 6");
        expect(text).toContain("...and 2 more");
        expect(text).toContain(`${MESSAGE_TRUST_NOTE} ${NOTIFY_CLOSING}`);
        expect(await status(`claude:${s("rcv")}`)).toBe("working");

        // Every unread message was marked notified, so a tool call adds nothing.
        expect(await hook("claude", "PostToolUse", s("rcv"))).toBeNull();
        // The next prompt still lists them while they are unread.
        expect(context(await hook("claude", "UserPromptSubmit", s("rcv")))).toContain("7 unread direct messages");
    });

    it("lists notices alone without the message note", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("watcher"));
        await hook("codex", "SessionStart", s("target"));
        await send(s("watcher"), `codex:${s("target")}`, "ping", true);
        await codexTool(s("target"), "read");
        await hook("codex", "Stop", s("target"));

        const text = context(await hook("codex", "UserPromptSubmit", s("watcher")));
        expect(text).toBe(`${NOTICE_PREFIX} Notices:\n- codex@proj#2 (codex:${s("target")}) finished its turn.`);
        expect(await hook("codex", "UserPromptSubmit", s("watcher"))).toBeNull(); // notices are delivered once
    });

    it("PostToolUse reports only what was not notified yet", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("s"));
        await hook("claude", "SessionStart", s("r"));
        await send(s("s"), `claude:${s("r")}`, "first");
        const first = await hook("claude", "PostToolUse", s("r"), { tool_use_id: "t1", tool_name: "Bash" });
        expect(first?.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
        expect(context(first)).toContain(`${NOTICE_PREFIX} 1 new direct message:`);
        expect(context(first)).toContain("first");
        expect(await status(`claude:${s("r")}`)).toBe("working");

        expect(await hook("claude", "PostToolUse", s("r"))).toBeNull();

        await send(s("s"), `claude:${s("r")}`, "second");
        const second = context(await hook("claude", "PostToolUse", s("r")));
        expect(second).toContain("second");
        expect(second).not.toContain("first");
    });

    it("Stop blocks once while anything is unread, then lets the turn end", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("s"));
        await hook("claude", "SessionStart", s("r"));
        expect(await hook("claude", "Stop", s("r"), { stop_hook_active: false })).toBeNull();
        expect(await status(`claude:${s("r")}`)).toBe("idle");

        await send(s("s"), `claude:${s("r")}`, "please look");
        await hook("claude", "UserPromptSubmit", s("r"));                       // already notified: Stop still blocks
        const blocked = await hook("claude", "Stop", s("r"), { stop_hook_active: false });
        expect(blocked?.decision).toBe("block");
        expect(blocked?.reason?.startsWith(`${NOTICE_PREFIX} 1 unread direct message:`)).toBe(true);
        expect(blocked?.reason).toContain("please look");
        // Continuing a turn that was about to end asks for read and reply, not just a look.
        expect(blocked?.reason).toContain(`${MESSAGE_TRUST_NOTE} ${STOP_CLOSING}`);
        expect(blocked?.reason).not.toContain("Automatic turn");                // no limit by default, so no count
        expect(await status(`claude:${s("r")}`)).toBe("working");

        expect(await hook("claude", "Stop", s("r"), { stop_hook_active: true })).toBeNull();
        expect(await status(`claude:${s("r")}`)).toBe("idle");
    });
});

describe("POST /api/hook: background wait", () => {
    it("ends without output when the session becomes active, times out or the client goes away", async () => {
        const s = ids();
        const r = `claude:${s("r")}`;
        await hook("claude", "SessionStart", s("r"));
        await hook("claude", "Stop", s("r"));

        const cancelled = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
        await until(async () => (await status(r)) === "listening");
        await hook("claude", "UserPromptSubmit", s("r"));
        expect((await cancelled.response).payload.output).toBeNull();
        expect(await status(r)).toBe("working");

        await hook("claude", "Stop", s("r"));
        const timedOut = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
        expect((await timedOut.response).payload.output).toEqual({ timeout: true });
        expect(await status(r)).toBe("idle");

        const gone = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
        gone.response.catch(() => undefined);
        await until(async () => (await status(r)) === "listening");
        gone.cancel();
        await until(async () => (await status(r)) === "idle");
    });

    it("leaves delivery to a listening Stop hook while it waits, and takes over when that wait ends", async () => {
        const s = ids();
        const r = `codex:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("codex", "UserPromptSubmit", s("r"));
        await codexTool(s("r"), "listen", { on: true });
        const background = openHook("codex", BACKGROUND_WAIT_EVENT, s("r"));   // registered first
        const listening = openHook("codex", "Stop", s("r"), { stop_hook_active: false });
        await until(async () => (await status(r)) === "listening");
        await send(s("s"), r, "for the listening stop");
        const stop = (await listening.response).payload.output;
        expect(stop?.decision).toBe("block");
        expect(stop?.reason).toContain("for the listening stop");

        expect((await background.response).payload.output).toEqual({ timeout: true });   // it did not take the message

        // The next listening Stop times out (LISTEN_MS); the client's next background wait delivers what arrives then.
        await hook("codex", "Stop", s("r"), { stop_hook_active: true });
        const again = openHook("codex", BACKGROUND_WAIT_EVENT, s("r"));
        await until(async () => (await status(r)) === "listening");
        await send(s("s"), r, "for the background wait");
        const { payload } = await again.response;
        expect(payload.output?.wake).toContain("for the background wait");
        expect(payload.output?.wake).not.toContain("for the listening stop");
    });

    it("with listen on, leaves listening once neither a background wait nor a listening Stop is pending", async () => {
        const s = ids();
        const r = `codex:${s("r")}`;
        await hook("codex", "SessionStart", s("r"));
        await codexTool(s("r"), "listen", { on: true });
        expect(await hook("codex", "Stop", s("r"), { stop_hook_active: true })).toBeNull();   // listening Stop times out
        expect(await status(r)).toBe("idle");
        const background = openHook("codex", BACKGROUND_WAIT_EVENT, s("r"));
        await until(async () => (await status(r)) === "listening");
        expect((await background.response).payload.output).toEqual({ timeout: true });
        expect(await status(r)).toBe("idle");                                   // the client asks no more: it can go stale
    });

    it("never runs for an unknown session", async () => {
        expect(await hook("claude", BACKGROUND_WAIT_EVENT, ids()("nobody"))).toBeNull();
    });
});

describe("POST /api/hook: listen mode", () => {
    it("times out to idle, and messages already notified do not wake it", async () => {
        const s = ids();
        const r = `codex:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("codex", "SessionStart", s("r"));
        await codexTool(s("r"), "listen", { on: true });

        expect(await hook("codex", "Stop", s("r"))).toBeNull();
        expect(await status(r)).toBe("idle");

        await send(s("s"), r, "old news");
        await hook("codex", "UserPromptSubmit", s("r"));
        const startedAt = Date.now();
        expect(await hook("codex", "Stop", s("r"), { stop_hook_active: true })).toBeNull();
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(LISTEN_MS - 20);
        expect(await status(r)).toBe("idle");
    });

    it("returns immediately with what arrived but was not notified before the wait began", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("s"));
        await hook("codex", "SessionStart", s("r"));
        await codexTool(s("r"), "listen", { on: true });
        await send(s("s"), `codex:${s("r")}`, "during continuation");
        const out = await hook("codex", "Stop", s("r"), { stop_hook_active: true });
        expect(out?.reason).toContain("during continuation");
        expect(await status(`codex:${s("r")}`)).toBe("working");
    });
});

describe("POST /api/hook: idle subscriptions", () => {
    it("notifies a subscriber once when the target ends its turn, starts listening or goes offline", async () => {
        const s = ids();
        const t = `claude:${s("t")}`;
        await hook("codex", "SessionStart", s("w"));
        await hook("claude", "SessionStart", s("t"));

        await send(s("w"), t, "task", true);
        await claudeTool(s("t"), "read");
        await hook("claude", "Stop", s("t"));
        expect(context(await hook("codex", "UserPromptSubmit", s("w")))).toContain(`claude@proj (${t}) finished its turn.`);
        await hook("claude", "Stop", s("t"));                                    // the subscription was one-shot
        expect(await hook("codex", "UserPromptSubmit", s("w"))).toBeNull();

        // Entering listen mode counts as finishing the turn.
        await send(s("w"), t, "task 2", true);
        await claudeTool(s("t"), "read");
        await claudeTool(s("t"), "listen", { on: true });
        expect(await hook("claude", "Stop", s("t"))).toBeNull();                 // waits LISTEN_MS, then idle
        expect(context(await hook("codex", "UserPromptSubmit", s("w")))).toContain("finished its turn.");

        await send(s("w"), t, "task 3", true);
        await hook("claude", "SessionEnd", s("t"));
        expect(context(await hook("codex", "UserPromptSubmit", s("w")))).toContain(`claude@proj (${t}) went offline.`);
    });
});

describe("POST /api/hook: Claude tool-use bindings", () => {
    it("resolves a Claude tool call through the PreToolUse binding; an unbound toolUseId names no session", async () => {
        const s = ids();
        await hook("claude", "SessionStart", s("a"));
        const toolUseId = `toolu_1_${s("a")}`;
        expect(await hook("claude", "PreToolUse", s("a"), { tool_use_id: toolUseId })).toBeNull();
        const call = (id: string) => host.callTool<{ self: { id: string } }>("peers", {}, null, { client: "claude", toolUseId: id });
        expect((await call(toolUseId)).payload.result?.self.id).toBe(`claude:${s("a")}`);
        const unknown = await call(`toolu_unknown_${s("a")}`);
        expect(unknown.status).toBe(400);
        expect(unknown.payload).toEqual({ ok: false, error: NO_AGENT_SESSION_ERROR } satisfies ToolReply<never>);

        // A PreToolUse without tool_use_id binds nothing and prints nothing.
        expect(await hook("claude", "PreToolUse", s("a"))).toBeNull();
    });
});
