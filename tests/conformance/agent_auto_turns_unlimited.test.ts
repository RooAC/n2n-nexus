// maxAutoTurns 0: no automatic turn limit.
import { afterEach, describe, expect, it } from "vitest";
import { useHost } from "./harness.js";
import { agentKit, ids } from "./agents.js";

const host = useHost({ listenWaitMs: 300, maxAutoTurns: 0, rateLimit: 0 });
const { hook, codexTool, send, endSessions } = agentKit(host);
afterEach(() => endSessions());

describe("POST /api/hook: no automatic turn limit", () => {
    it("never limits with maxAutoTurns 0 and adds no turn count", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("s"));
        await hook("codex", "UserPromptSubmit", s("r"));
        for (let i = 0; i < 3; i++) {
            await send(s("s"), `codex:${s("r")}`, `m${i}`);
            const out = await hook("codex", "Stop", s("r"), { stop_hook_active: false });
            expect(out?.decision).toBe("block");
            expect(out?.reason).not.toContain("Automatic turn");
            await codexTool(s("r"), "read");
        }
    });
});
