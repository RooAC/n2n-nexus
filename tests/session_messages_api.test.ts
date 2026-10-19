import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectMessage } from "../src/storage/direct-messages.js";
import type { Session } from "../src/storage/sessions.js";
import { startTestDaemon, type DaemonHarness } from "./helpers/daemon.js";

type ToolResult<T> = { ok: boolean; result?: T; error?: string };
type Sent = { sentTo: string; messageId: string; status: DirectMessage["status"]; to: string; replyTo: string | null };
type Inbox = { sessionId: string; messages: DirectMessage[]; count: number };
type Listed = { self: Session | null; sessions: Session[]; count: number };

const instanceId = "same-ide-and-workspace";
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const c = "00000000-0000-4000-8000-000000000003";

describe("Session discovery and direct messages through the daemon", () => {
    let daemon: DaemonHarness;
    let previousRoot: string | undefined;

    const call = <T>(sessionId: string | undefined, tool: string, args: Record<string, unknown> = {}) =>
        daemon.request<ToolResult<T>>("POST", "/api/tools/call", { tool, args, instanceId, sessionId });
    const get = (sessionId: string, messageId: string) => call<{ message: DirectMessage }>(sessionId, "get_message", { messageId });
    const inbox = (sessionId: string) => call<Inbox>(sessionId, "read_inbox");

    beforeEach(async () => {
        previousRoot = process.env.NEXUS_ROOT;
        daemon = await startTestDaemon("session-messages-api");
        for (const sessionId of [a, b, c]) {
            const registered = await daemon.request<{ ok: boolean; session: Session }>("POST", "/api/sessions/register", {
                sessionId, instanceId, clientName: "test-client", workspace: "/same/workspace"
            });
            expect(registered.status).toBe(200);
            expect(registered.payload.session).toMatchObject({ sessionId, instanceId, online: true, reception: "pull" });
        }
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        try {
            await daemon?.close();
        } finally {
            if (previousRoot === undefined) delete process.env.NEXUS_ROOT;
            else process.env.NEXUS_ROOT = previousRoot;
        }
    });

    it("distinguishes sessions sharing an instance and exposes disconnect and lease expiry", async () => {
        for (const sessionId of [a, b]) {
            const updated = await call<{ session: Session }>(sessionId, "update_session", { name: "Reviewer", projectId: "shared-project" });
            expect(updated.status).toBe(200);
        }
        const listed = await call<Listed>(a, "list_sessions", { projectId: "shared-project" });
        expect(listed.payload.result?.self?.sessionId).toBe(a);
        expect(listed.payload.result?.sessions.map(s => s.sessionId).sort()).toEqual([a, b]);
        expect(listed.payload.result?.count).toBe(2);

        const disconnected = await daemon.request("POST", "/api/sessions/disconnect", { sessionId: b, instanceId });
        expect(disconnected.status).toBe(200);
        expect((await call<Listed>(undefined, "list_sessions", { projectId: "shared-project" })).payload.result?.sessions.map(s => s.sessionId)).toEqual([a]);
        const includingOffline = await call<Listed>(undefined, "list_sessions", { onlineOnly: false, projectId: "shared-project" });
        expect(includingOffline.payload.result?.self).toBeNull();
        expect(includingOffline.payload.result?.sessions.find(s => s.sessionId === b)?.online).toBe(false);

        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
        expect((await call<Listed>(undefined, "list_sessions")).payload.result?.sessions).toEqual([]);
    });

    it("delivers only to the target, allows retry before acknowledgement, and links replies", async () => {
        const sent = await call<Sent>(a, "send_message", { to: b, message: "Review the change" });
        expect(sent.status).toBe(200);
        expect(sent.payload.result).toMatchObject({ sentTo: "session", status: "accepted", to: b, replyTo: null });
        const messageId = sent.payload.result!.messageId;
        expect((await inbox(a)).payload.result?.count).toBe(0);
        expect((await inbox(c)).payload.result?.count).toBe(0);
        const fetched = await inbox(b);
        expect(fetched.payload.result).toMatchObject({ sessionId: b, count: 1 });
        expect(fetched.payload.result?.messages[0]).toMatchObject({ messageId, from: a, to: b, text: "Review the change", status: "fetched" });
        expect((await inbox(b)).payload.result?.messages).toEqual(fetched.payload.result?.messages);
        expect((await get(a, messageId)).payload.result?.message.status).toBe("fetched");

        const acknowledged = await call<{ message: DirectMessage }>(b, "acknowledge_message", { messageId });
        expect(acknowledged.payload.result?.message.status).toBe("acknowledged");
        expect((await call(b, "acknowledge_message", { messageId })).payload.result).toEqual(acknowledged.payload.result);
        expect((await inbox(b)).payload.result?.count).toBe(0);

        const replied = await call<Sent>(b, "send_message", { to: a, message: "Looks good", replyTo: messageId });
        expect(replied.payload.result).toMatchObject({ status: "accepted", replyTo: messageId });
        expect((await get(a, messageId)).payload.result?.message.status).toBe("replied");
        expect((await inbox(a)).payload.result?.messages[0]).toMatchObject({ from: b, to: a, replyTo: messageId, text: "Looks good" });
    });

    it("requires the registered caller and prevents other sessions from reading, acknowledging or claiming replies", async () => {
        expect((await call(undefined, "send_message", { to: b, message: "missing caller", sessionId: a })).status).toBe(400);
        expect((await call("unregistered", "read_inbox")).status).toBe(400);
        const mismatch = await daemon.request("POST", "/api/tools/call", { tool: "read_inbox", args: {}, sessionId: b, instanceId: "another-instance" });
        expect(mismatch.status).toBe(400);

        const sent = await call<Sent>(a, "send_message", { to: b, message: "Private question" });
        const messageId = sent.payload.result!.messageId;
        await inbox(b);
        expect((await get(c, messageId)).status).toBe(400);
        expect((await call(a, "acknowledge_message", { messageId })).status).toBe(400);
        expect((await call(c, "acknowledge_message", { messageId, sessionId: b })).status).toBe(400);
        expect((await call(c, "send_message", { to: a, message: "Not my question", replyTo: messageId })).status).toBe(400);
        expect((await call(b, "send_message", { to: c, message: "Wrong recipient", replyTo: messageId })).status).toBe(400);
        expect((await get(a, messageId)).payload.result?.message.status).toBe("fetched");
        expect((await inbox(a)).payload.result?.count).toBe(0);
        expect((await inbox(c)).payload.result?.count).toBe(0);
    });

    it.each([
        ["register", a, "another-instance"],
        ["disconnect", "unregistered", instanceId]
    ])("returns a caller error for an invalid session %s request", async (action, sessionId, callerInstanceId) => {
        const result = await daemon.request("POST", `/api/sessions/${action}`, { sessionId, instanceId: callerInstanceId });
        expect(result.status).toBe(400);
    });

    it("records refusal without delivery or a false replied state, and expires only pending messages", async () => {
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now);
        const question = await call<Sent>(a, "send_message", { to: b, message: "Question", ttlMs: 1_000 });
        const acknowledged = await call<Sent>(a, "send_message", { to: b, message: "Keep acknowledgement", ttlMs: 1_000 });
        const declined = await call<Sent>(a, "send_message", { to: b, message: "Decline this", ttlMs: 1_000 });
        await inbox(b);
        await call(b, "acknowledge_message", { messageId: acknowledged.payload.result!.messageId });
        const refused = await call<{ message: DirectMessage }>(b, "acknowledge_message", { messageId: declined.payload.result!.messageId, outcome: "refused" });
        expect(refused.payload.result?.message.status).toBe("refused");
        expect((await call(b, "acknowledge_message", { messageId: declined.payload.result!.messageId, outcome: "refused" })).payload.result).toEqual(refused.payload.result);

        await call(a, "update_session", { inbound: "refuse" });
        const refusedReply = await call<Sent>(b, "send_message", { to: a, message: "Answer", replyTo: question.payload.result!.messageId });
        expect(refusedReply.payload.result?.status).toBe("refused");
        expect((await get(b, refusedReply.payload.result!.messageId)).payload.result?.message.status).toBe("refused");
        expect((await inbox(a)).payload.result?.count).toBe(0);
        expect((await get(a, question.payload.result!.messageId)).payload.result?.message.status).toBe("fetched");

        const pending = await call<Sent>(a, "send_message", { to: b, message: "Never fetched", ttlMs: 1_000 });
        vi.mocked(Date.now).mockReturnValue(now + 1_001);
        expect((await get(a, question.payload.result!.messageId)).payload.result?.message.status).toBe("expired");
        expect((await get(a, pending.payload.result!.messageId)).payload.result?.message.status).toBe("expired");
        expect((await get(a, acknowledged.payload.result!.messageId)).payload.result?.message.status).toBe("acknowledged");
        expect((await inbox(b)).payload.result?.count).toBe(0);
    });

    it("keeps global and meeting routing and never broadcasts invalid direct requests", async () => {
        const global = await call<{ sentTo: string }>(undefined, "send_message", { message: "Global" });
        expect(global.payload.result?.sentTo).toBe("global");
        const started = await call<{ meetingId: string }>(undefined, "start_meeting", { topic: "Existing meeting" });
        const meetingId = started.payload.result!.meetingId;
        expect((await call<{ sentTo: string }>(undefined, "send_message", { message: "Meeting" })).payload.result?.sentTo).toBe("meeting");

        const invalid = [
            { to: b, meetingId },
            { replyTo: "missing-message" },
            { ttlMs: 1_000 },
            { to: "missing-session" }
        ];
        for (const args of invalid) {
            expect((await call(a, "send_message", { ...args, message: "Must not broadcast" })).status).toBe(400);
        }
        const direct = await call<Sent>(a, "send_message", { to: b, message: "Direct while meeting is active" });
        expect(direct.payload.result?.sentTo).toBe("session");
        const meeting = await call<{ messages: { text: string }[] }>(undefined, "read_messages", { meetingId, count: 20 });
        expect(meeting.payload.result?.messages.map(message => message.text)).toEqual(["Meeting"]);
        expect((await inbox(b)).payload.result?.messages.map(message => message.text)).toEqual(["Direct while meeting is active"]);
    });
});
