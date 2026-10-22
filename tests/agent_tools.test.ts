import http from "node:http";
import { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDaemonServer } from "../src/daemon/server.js";
import { closeDatabase, getDatabase } from "../src/storage/sqlite.js";
import { StorageManager } from "../src/storage/index.js";
import { AgentStore } from "../src/storage/agents.js";
import { MAX_NOTE_CHARS, NO_AGENT_SESSION_ERROR, PEER_WINDOW_MS, type Caller, type HookClient } from "../src/daemon/hook-contract.js";
import { requestJson } from "./helpers/daemon.js";

type ToolReply<T> = { ok: boolean; result?: T; error?: string };
type Profile = { id: string; name: string; client: HookClient; cwd: string; note: string; status: string; lastActiveAt: string };
type Sent = { messageId: string; to: { id: string; name: string; status: string } };
type Read = {
    messages: { messageId: string; from: { id: string; name: string }; replyTo: string | null; text: string; createdAt: string }[];
    remaining: number;
};

let port = 0;
let server: http.Server | null = null;
const previousRoot = process.env.NEXUS_ROOT;

beforeEach(async () => {
    const root = path.join(process.cwd(), "tests", "tmp", "agent-tools");
    closeDatabase();
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    process.env.NEXUS_ROOT = root;
    StorageManager.resetInit();
    ({ server } = await createDaemonServer({ port: 0, version: "test", listenWaitMs: 300 }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    port = (server!.address() as AddressInfo).port;
});

afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    closeDatabase();
    if (previousRoot === undefined) delete process.env.NEXUS_ROOT;
    else process.env.NEXUS_ROOT = previousRoot;
});

async function hook(client: HookClient, event: string, sessionId: string, cwd = "/work/proj") {
    const res = await requestJson<{ output: unknown }>(port, "POST", "/api/hook", { client, input: { hook_event_name: event, session_id: sessionId, cwd } });
    expect(res.status).toBe(200);
    return res.payload.output;
}

const callAs = <T>(caller: unknown, tool: string, args: Record<string, unknown> = {}) =>
    requestJson<ToolReply<T>>(port, "POST", "/api/tools/call", { tool, args, instanceId: "i", ...(caller === undefined ? {} : { caller }) });

/** Codex sessions name themselves directly. */
const codex = <T>(sessionId: string, tool: string, args: Record<string, unknown> = {}) =>
    callAs<T>({ client: "codex", sessionId } satisfies Caller, tool, args);

let toolUseSeq = 0;
/** Claude sessions go through a PreToolUse binding. */
async function claude<T>(sessionId: string, tool: string, args: Record<string, unknown> = {}) {
    const toolUseId = `toolu_${++toolUseSeq}`;
    await requestJson(port, "POST", "/api/hook", { client: "claude", input: { hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: toolUseId } });
    return callAs<T>({ client: "claude", toolUseId } satisfies Caller, tool, args);
}

const DM_TOOLS: [string, Record<string, unknown>][] = [
    ["peers", {}], ["send", { to: "x", text: "hi" }], ["read", {}], ["reply", { messageId: "m", text: "hi" }],
    ["listen", { on: true }], ["set_profile", { note: "n" }]
];

describe("direct-message tools: identity", () => {
    it("rejects all six tools without a resolvable session and leaves other tools alone", async () => {
        await hook("claude", "SessionStart", "known");
        const noSession = { status: 400, payload: { ok: false, error: NO_AGENT_SESSION_ERROR } };
        for (const [tool, args] of DM_TOOLS) {
            expect(await callAs(undefined, tool, args)).toEqual(noSession);                             // other MCP clients
            expect(await codex("missing", tool, args)).toEqual(noSession);                               // Codex without hooks
            expect(await callAs({ client: "claude", toolUseId: "unbound" }, tool, args)).toEqual(noSession);
        }
        // A malformed caller names no session.
        expect(await callAs({ client: "claude" }, "peers")).toEqual(noSession);
        expect(await callAs({ client: "cursor", sessionId: "x" }, "peers")).toEqual(noSession);
        // Other tools ignore the caller, malformed or not.
        expect((await callAs(undefined, "list_meetings")).status).toBe(200);
        expect((await callAs({ client: "codex", sessionId: "missing" }, "list_meetings")).status).toBe(200);
        expect((await callAs({ client: "cursor", sessionId: "x" }, "list_meetings")).status).toBe(200);
    });

    it("validates arguments and refreshes the caller's last activity on every call", async () => {
        await hook("codex", "SessionStart", "a");
        expect((await codex("a", "read", { count: 51 })).status).toBe(400);
        expect((await codex("a", "send", { to: "x", text: "" })).status).toBe(400);
        expect((await codex("a", "listen", {})).status).toBe(400);

        const later = Date.now() + 60_000;
        vi.spyOn(Date, "now").mockReturnValue(later);
        expect((await codex("a", "listen", { on: false })).status).toBe(200);
        expect(AgentStore.get("codex:a")?.lastActiveAt).toBe(new Date(later).toISOString());
    });
});

describe("direct-message tools: peers, listen, set_profile", () => {
    it("peers returns self and other sessions not offline or active within PEER_WINDOW_MS, most recent first", async () => {
        const t0 = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(t0 - PEER_WINDOW_MS - 60_000);
        await hook("codex", "SessionStart", "gone", "/work/old");
        await hook("codex", "SessionEnd", "gone");
        await hook("codex", "SessionStart", "stale", "/work/stale");             // never ended, but stale: offline and too old to list
        vi.spyOn(Date, "now").mockReturnValue(t0 - 2000);
        await hook("claude", "SessionStart", "recent-offline");
        await hook("claude", "SessionEnd", "recent-offline");
        vi.spyOn(Date, "now").mockReturnValue(t0 - 1000);
        await hook("claude", "SessionStart", "me", "/work/mine");
        await hook("codex", "UserPromptSubmit", "busy");
        vi.spyOn(Date, "now").mockReturnValue(t0);

        const { payload } = await claude<{ self: Profile; peers: Profile[] }>("me", "peers");
        expect(payload.result?.self).toEqual({
            id: "claude:me", name: "claude@mine", client: "claude", cwd: "/work/mine", note: "", status: "idle",
            lastActiveAt: new Date(t0).toISOString()
        });
        expect(payload.result?.peers.map(p => [p.id, p.status])).toEqual([
            ["codex:busy", "working"], ["claude:recent-offline", "offline"]
        ]);
        expect(AgentStore.get("codex:stale")?.status).toBe("offline");
        expect(Object.keys(payload.result!.peers[0]).sort()).toEqual(["client", "cwd", "id", "lastActiveAt", "name", "note", "status"]);
    });

    it("listen sets the flag and returns it", async () => {
        await hook("codex", "SessionStart", "a");
        expect((await codex("a", "listen", { on: true })).payload.result).toEqual({ listening: true });
        expect(AgentStore.get("codex:a")?.listening).toBe(true);
        expect((await codex("a", "listen", { on: false })).payload.result).toEqual({ listening: false });
        expect(AgentStore.get("codex:a")?.listening).toBe(false);
    });

    it("set_profile validates, keeps names unique among sessions that are not offline and returns the profile", async () => {
        await hook("codex", "SessionStart", "a");
        await hook("codex", "SessionStart", "b");
        await hook("codex", "SessionStart", "c");
        await hook("codex", "SessionEnd", "c");

        expect((await codex("a", "set_profile", {})).status).toBe(400);
        expect((await codex("a", "set_profile", { name: "has space" })).status).toBe(400);
        expect((await codex("a", "set_profile", { name: "x".repeat(49) })).status).toBe(400);
        expect((await codex("a", "set_profile", { note: "n".repeat(MAX_NOTE_CHARS + 1) })).status).toBe(400);

        const taken = await codex("a", "set_profile", { name: "codex@proj#2" });
        expect(taken.status).toBe(400);
        expect(taken.payload.error).toContain("already used");
        expect(AgentStore.get("codex:a")?.name).toBe("codex@proj");

        // The offline session's name is free; the session's own current name is fine too.
        const renamed = await codex<{ profile: Profile }>("a", "set_profile", { name: "codex@proj#3", note: "reviewing" });
        expect(renamed.payload.result?.profile).toMatchObject({ id: "codex:a", name: "codex@proj#3", note: "reviewing" });
        expect((await codex<{ profile: Profile }>("a", "set_profile", { name: "codex@proj#3" })).status).toBe(200);
        const noteOnly = await codex<{ profile: Profile }>("a", "set_profile", { note: "" });
        expect(noteOnly.payload.result?.profile).toMatchObject({ name: "codex@proj#3", note: "" });
    });
});

describe("direct-message tools: send, reply, read", () => {
    it("send resolves `to` by id (any status) or by the name of a session that is not offline", async () => {
        await hook("claude", "SessionStart", "a", "/work/alpha");
        await hook("codex", "SessionStart", "b", "/work/beta");
        await hook("codex", "SessionStart", "off", "/work/off");
        await hook("codex", "SessionEnd", "off");

        const byName = await claude<Sent>("a", "send", { to: "codex@beta", text: "by name" });
        expect(byName.status).toBe(200);
        expect(byName.payload.result).toEqual({ messageId: expect.any(String), to: { id: "codex:b", name: "codex@beta", status: "idle" } });

        const byId = await claude<Sent>("a", "send", { to: "codex:off", text: "to offline" });
        expect(byId.payload.result?.to).toEqual({ id: "codex:off", name: "codex@off", status: "offline" });

        const offlineName = await claude("a", "send", { to: "codex@off", text: "x" });
        expect(offlineName.status).toBe(400);
        expect(offlineName.payload.error).toContain("Unknown recipient");
        expect((await claude("a", "send", { to: "nobody", text: "x" })).payload.error).toContain("Unknown recipient");

        const self = await claude("a", "send", { to: "claude@alpha", text: "x" });
        expect(self.status).toBe(400);
        expect(self.payload.error).toContain("yourself");
        expect((await claude("a", "send", { to: "claude:a", text: "x" })).status).toBe(400);

        // Offline recipients keep their messages and are told when they come back.
        await hook("codex", "SessionStart", "off", "/work/off");
        expect(JSON.stringify(await hook("codex", "UserPromptSubmit", "off"))).toContain("to offline");
    });

    it("read returns unread messages oldest first in pages and marks them read", async () => {
        await hook("codex", "SessionStart", "s");
        await hook("claude", "SessionStart", "r");
        const ids: string[] = [];
        for (let i = 1; i <= 3; i++) ids.push((await codex<Sent>("s", "send", { to: "claude:r", text: `m${i}` })).payload.result!.messageId);

        const first = await claude<Read>("r", "read", { count: 2 });
        expect(first.payload.result).toEqual({
            messages: [
                { messageId: ids[0], from: { id: "codex:s", name: "codex@proj" }, replyTo: null, text: "m1", createdAt: expect.any(String) },
                { messageId: ids[1], from: { id: "codex:s", name: "codex@proj" }, replyTo: null, text: "m2", createdAt: expect.any(String) }
            ],
            remaining: 1
        });
        const rows = getDatabase().prepare("SELECT status, read_at, notified_at FROM agent_messages WHERE id IN (?, ?)").all(ids[0], ids[1]) as
            { status: string; read_at: string | null; notified_at: string | null }[];
        for (const row of rows) {
            expect(row.status).toBe("read");
            expect(row.read_at).not.toBeNull();
            expect(row.notified_at).not.toBeNull();
        }
        const second = await claude<Read>("r", "read");
        expect(second.payload.result?.messages.map(m => m.text)).toEqual(["m3"]);
        expect(second.payload.result?.remaining).toBe(0);
        expect((await claude<Read>("r", "read")).payload.result).toEqual({ messages: [], remaining: 0 });
        // Nothing unread is left to notify about.
        expect(await hook("claude", "UserPromptSubmit", "r")).toBeNull();
    });

    it("reply answers only messages sent to the caller, to the original sender, linked by replyTo", async () => {
        await hook("codex", "SessionStart", "s");
        await hook("claude", "SessionStart", "r");
        await hook("claude", "SessionStart", "other");
        const original = (await codex<Sent>("s", "send", { to: "claude:r", text: "question" })).payload.result!.messageId;

        const notMine = await claude("other", "reply", { messageId: original, text: "x" });
        expect(notMine.status).toBe(400);
        expect(notMine.payload.error).toContain("was not sent to you");
        expect((await codex("s", "reply", { messageId: original, text: "x" })).status).toBe(400);   // the sender cannot reply to its own message
        expect((await claude("r", "reply", { messageId: "no-such", text: "x" })).status).toBe(400);

        await claude("r", "read");                                                                     // read messages can still be answered
        const replied = await claude<Sent>("r", "reply", { messageId: original, text: "answer" });
        expect(replied.payload.result?.to).toEqual({ id: "codex:s", name: "codex@proj", status: "idle" });

        const inbox = await codex<Read>("s", "read");
        expect(inbox.payload.result?.messages).toEqual([
            { messageId: replied.payload.result!.messageId, from: { id: "claude:r", name: "claude@proj" }, replyTo: original, text: "answer", createdAt: expect.any(String) }
        ]);
    });
});
