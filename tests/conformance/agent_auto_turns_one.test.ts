// Automatic turn limit with maxAutoTurns 1.
import { afterEach, describe, expect, it } from "vitest";
import { until, useHost } from "./harness.js";
import { agentKit, ids } from "./agents.js";

const host = useHost({ listenWaitMs: 300, maxAutoTurns: 1, rateLimit: 0 });
const { hook, openHook, codexTool, send, status, endSessions } = agentKit(host);
afterEach(() => endSessions());

describe("POST /api/hook: automatic turn limit of 1", () => {
    it("counts a Stop held open for unread messages, and lets the turn end once the limit is reached", async () => {
        const s = ids();
        const r = `codex:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("codex", "UserPromptSubmit", s("r"));
        await send(s("s"), r, "first");
        const blocked = await hook("codex", "Stop", s("r"), { stop_hook_active: false });
        expect(blocked?.decision).toBe("block");
        expect(blocked?.reason).toContain("Automatic turn 1 of 1");

        await send(s("s"), r, "second");
        expect(await hook("codex", "Stop", s("r"), { stop_hook_active: false })).toBeNull();
        expect(await status(r)).toBe("idle");
    });

    it("ends a listening Stop hook without delivering once the limit is reached", async () => {
        const s = ids();
        const r = `codex:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("codex", "SessionStart", s("r"));
        await codexTool(s("r"), "listen", { on: true });
        const first = openHook("codex", "Stop", s("r"), { stop_hook_active: false });
        await until(async () => (await status(r)) === "listening");
        await send(s("s"), r, "one");
        expect((await first.response).payload.output?.reason).toContain("Automatic turn 1 of 1");

        const second = await hook("codex", "Stop", s("r"), { stop_hook_active: true });
        expect(second).toBeNull();
        expect(await status(r)).toBe("idle");
    });
});
