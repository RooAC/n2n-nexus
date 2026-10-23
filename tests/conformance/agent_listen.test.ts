// POST /api/hook with a listening wait far longer than any test: whatever ends a
// wait here is the event under test, never the timeout. The last test stops the host.
import { afterEach, describe, expect, it } from "vitest";
import { until, useHost } from "./harness.js";
import { BACKGROUND_WAIT_EVENT, NOTICE_PREFIX, agentKit, ids } from "./agents.js";

const host = useHost({ listenWaitMs: 60_000, rateLimit: 0 });
const { hook, openHook, claudeTool, codexTool, send, status, endSessions } = agentKit(host);
afterEach(async () => { if (host.running) await endSessions(); });

describe("POST /api/hook: background wait", () => {
    it("shows the session as listening and returns a new message as soon as it arrives", async () => {
        const s = ids();
        const r = `claude:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("claude", "SessionStart", s("r"));
        await hook("claude", "Stop", s("r"), { stop_hook_active: false });
        const waiting = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
        await until(async () => (await status(r)) === "listening");
        await send(s("s"), r, "wake up");
        const { payload } = await waiting.response;
        expect(payload.output?.wake).toContain(`${NOTICE_PREFIX} 1 new direct message:`);
        expect(payload.output?.wake).toContain("wake up");
        expect(await status(r)).toBe("working");
        expect(await hook("claude", "UserPromptSubmit", s("r"))).not.toBeNull();  // still unread until read
    });

    it("waits while the turn is still ending, and Stop keeps the session listening", async () => {
        const s = ids();
        const r = `codex:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("codex", "UserPromptSubmit", s("r"));
        await send(s("s"), r, "before the turn ended");
        const waiting = openHook("codex", BACKGROUND_WAIT_EVENT, s("r"));      // started alongside Stop
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await status(r)).toBe("working");

        // Stop announces the unread message itself; the wait must not repeat it.
        expect((await hook("codex", "Stop", s("r"), { stop_hook_active: false }))?.decision).toBe("block");
        expect(await hook("codex", "Stop", s("r"), { stop_hook_active: true })).toBeNull();
        expect(await status(r)).toBe("listening");
        await send(s("s"), r, "after");
        const { payload } = await waiting.response;
        expect(payload.output?.wake).toContain("after");
        expect(payload.output?.wake).not.toContain("before the turn ended");
    });
});

describe("POST /api/hook: listen mode", () => {
    it("wakes a listening session as soon as a new message arrives", async () => {
        const s = ids();
        const r = `codex:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("codex", "SessionStart", s("r"));
        await codexTool(s("r"), "listen", { on: true });

        const startedAt = Date.now();
        const waiting = openHook("codex", "Stop", s("r"), { stop_hook_active: false });
        await until(async () => (await status(r)) === "listening");
        await send(s("s"), r, "wake up");
        const { payload } = await waiting.response;
        expect(Date.now() - startedAt).toBeLessThan(5000);
        expect(payload.output?.decision).toBe("block");
        expect(payload.output?.reason).toContain(`${NOTICE_PREFIX} 1 new direct message:`);
        expect(payload.output?.reason).toContain("wake up");
        expect(await status(r)).toBe("working");
    });

    it("is woken by a notice, such as a notifyWhenIdle target finishing its turn", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("watcher"));
        await hook("codex", "SessionStart", s("target"));
        await send(s("watcher"), `codex:${s("target")}`, "do it", true);
        await codexTool(s("watcher"), "listen", { on: true });
        const waiting = openHook("codex", "Stop", s("watcher"));
        await until(async () => (await status(`codex:${s("watcher")}`)) === "listening");

        await codexTool(s("target"), "read");
        expect(await hook("codex", "Stop", s("target"))).toBeNull();
        const { payload } = await waiting.response;
        expect(payload.output?.decision).toBe("block");
        expect(payload.output?.reason).toBe(`${NOTICE_PREFIX} Notices:\n- codex@proj#2 (codex:${s("target")}) finished its turn.`);
    });

    it("listen sets the flag: Stop then waits instead of ending the turn", async () => {
        const s = ids();
        const a = `codex:${s("a")}`;
        await hook("codex", "SessionStart", s("a"));
        expect((await codexTool(s("a"), "listen", { on: true })).payload.result).toEqual({ listening: true });
        const waiting = openHook("codex", "Stop", s("a"));
        waiting.response.catch(() => undefined);
        await until(async () => (await status(a)) === "listening");
        waiting.cancel();
        await until(async () => (await status(a)) === "idle");

        expect((await codexTool(s("a"), "listen", { on: false })).payload.result).toEqual({ listening: false });
        expect(await hook("codex", "Stop", s("a"))).toBeNull();                 // returns at once: not listening
        expect(await status(a)).toBe("idle");
    });

    it("SessionEnd turns listening off", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("a"));
        await codexTool(s("a"), "listen", { on: true });
        await hook("codex", "SessionEnd", s("a"));
        await hook("codex", "SessionStart", s("a"));
        expect(await hook("codex", "Stop", s("a"))).toBeNull();                 // returns at once: not listening
        expect(await status(`codex:${s("a")}`)).toBe("idle");
    });

    it("cancels the wait and goes idle when the hook's client disconnects", async () => {
        const s = ids();
        const r = `claude:${s("r")}`;
        await hook("claude", "SessionStart", s("r"));
        await claudeTool(s("r"), "listen", { on: true });
        const waiting = openHook("claude", "Stop", s("r"));
        waiting.response.catch(() => undefined);
        await until(async () => (await status(r)) === "listening");
        waiting.cancel();
        await until(async () => (await status(r)) === "idle");
    });

    it("ends the wait when the conversation ends, and a later message stays unnotified while it is offline", async () => {
        const s = ids();
        const se = `claude:${s("se")}`;
        await hook("claude", "SessionStart", s("se"));
        await hook("codex", "SessionStart", s("sender"));
        await claudeTool(s("se"), "listen", { on: true });
        const waiting = openHook("claude", "Stop", s("se"));
        await until(async () => (await status(se)) === "listening");
        expect(await hook("claude", "SessionEnd", s("se"))).toBeNull();
        expect((await waiting.response).payload).toEqual({ output: null });
        await send(s("sender"), se, "after the end");
        expect(await status(se)).toBe("offline");

        // Nothing announced it while offline: the first tool call after coming back reports it as new.
        await hook("claude", "SessionStart", s("se"));
        const fresh = await hook("claude", "PostToolUse", s("se"));
        expect(fresh?.hookSpecificOutput?.additionalContext).toContain(`${NOTICE_PREFIX} 1 new direct message:`);
        expect(fresh?.hookSpecificOutput?.additionalContext).toContain("after the end");
    });

    it("ends the wait at once when the session turns listen off", async () => {
        const s = ids();
        const off = `claude:${s("off")}`;
        await hook("claude", "SessionStart", s("off"));
        await claudeTool(s("off"), "listen", { on: true });
        const waiting = openHook("claude", "Stop", s("off"));
        await until(async () => (await status(off)) === "listening");
        const started = Date.now();
        expect((await claudeTool(s("off"), "listen", { on: false })).payload.result).toEqual({ listening: false });
        expect((await waiting.response).payload).toEqual({ output: null });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(await status(off)).toBe("idle");
    });

    it("resets sessions a crashed host left listening, so they can go stale, and keeps listen on", async () => {
        const s = ids();
        const r = `codex:${s("r")}`;
        await hook("codex", "SessionStart", s("r"));
        await codexTool(s("r"), "listen", { on: true });
        const waiting = openHook("codex", "Stop", s("r"));
        waiting.response.catch(() => undefined);
        await until(async () => (await status(r)) === "listening");

        await host.restart("SIGKILL");                                          // no shutdown: the row stays "listening"
        expect(await status(r)).toBe("idle");
        const again = openHook("codex", "Stop", s("r"));                        // listen is still on: Stop waits
        again.response.catch(() => undefined);
        await until(async () => (await status(r)) === "listening");
        again.cancel();
        await until(async () => (await status(r)) === "idle");
    });

    it("lets the host shut down without waiting for a listening Stop hook (stops the host)", async () => {
        const s = ids();
        await hook("claude", "SessionStart", s("sd"));
        await claudeTool(s("sd"), "listen", { on: true });
        const waiting = openHook("claude", "Stop", s("sd"));
        await until(async () => (await status(`claude:${s("sd")}`)) === "listening");
        const started = Date.now();
        await host.stop("SIGTERM");
        expect(Date.now() - started).toBeLessThan(4000);                        // stop() kills after 5 s
        expect((await waiting.response).payload).toEqual({ output: null });
    });
});
