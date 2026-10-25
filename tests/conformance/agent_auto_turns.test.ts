// Automatic turn limit with maxAutoTurns 2 (one host per setting: see agent_auto_turns_one / _unlimited).
import { afterEach, describe, expect, it } from "vitest";
import { until, useHost } from "./harness.js";
import { BACKGROUND_WAIT_EVENT, agentKit, context, ids, type HookClient } from "./agents.js";

const host = useHost({ listenWaitMs: 2000, maxAutoTurns: 2, rateLimit: 0 });
const { hook, openHook, claudeTool, send, status, endSessions } = agentKit(host);
afterEach(() => endSessions());

describe("POST /api/hook: automatic turn limit", () => {
    /** The woken turn as the client runs it: its prompt, then the end of the turn. */
    async function wokenTurn(client: HookClient, sessionId: string) {
        await hook(client, "UserPromptSubmit", sessionId);
        await hook(client, "Stop", sessionId, { stop_hook_active: false });
    }

    it("wakes at most maxAutoTurns times until the user prompts; the woken turn's own prompt does not count", async () => {
        const s = ids();
        const r = `claude:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("claude", "SessionStart", s("r"));
        await hook("claude", "Stop", s("r"), { stop_hook_active: false });

        for (const n of [1, 2]) {
            const waiting = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
            await until(async () => (await status(r)) === "listening");
            await send(s("s"), r, `ping ${n}`);
            const wake = (await waiting.response).payload.output?.wake ?? "";
            expect(wake).toContain(`ping ${n}`);
            expect(wake).toContain(`Automatic turn ${n} of 2 since your user's last prompt; after turn 2, messages wait until your user prompts again.`);
            await claudeTool(s("r"), "read");
            await wokenTurn("claude", s("r"));
        }

        // The limit is reached: the wait still holds (meeting news would wake it), but the message only waits, unread and not announced.
        const third = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
        await until(async () => (await status(r)) === "listening");
        await send(s("s"), r, "ping 3");
        expect((await third.response).payload.output).toEqual({ timeout: true });
        expect(await status(r)).toBe("idle");

        // A real prompt (no wake just before it) starts counting again and announces the message.
        expect(context(await hook("claude", "UserPromptSubmit", s("r")))).toContain("ping 3");
        await claudeTool(s("r"), "read");
        await hook("claude", "Stop", s("r"), { stop_hook_active: false });
        const again = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
        await until(async () => (await status(r)) === "listening");
        await send(s("s"), r, "ping 4");
        expect((await again.response).payload.output?.wake).toContain("Automatic turn 1 of 2");
    });
});
