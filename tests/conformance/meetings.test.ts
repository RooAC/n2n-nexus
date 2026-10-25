// Meeting lifecycle and routing. Each test leaves no meeting active.
import { afterEach, describe, expect, it } from "vitest";
import { agentKit, ids } from "./agents.js";
import { useHost } from "./harness.js";

type Listed = {
    count: number; activeMeetingId: string | null;
    meetings: { id: string; status: string; participants: string[]; messageCount: number; decisionCount: number; summary?: string }[];
};

const host = useHost();
const start = async (topic: string, instanceId: string) =>
    (await host.callTool<{ meetingId: string }>("start_meeting", { topic }, instanceId)).payload.result!.meetingId;
const listed = async (args: Record<string, unknown> = {}) => (await host.callTool<Listed>("list_meetings", args)).payload.result!;

describe("meeting tools", () => {
    it("start -> end -> archive -> reopen, by any adapter instance", async () => {
        const started = await host.callTool<{ meetingId: string; topic: string; status: string }>("start_meeting", { topic: "Release plan" }, "ide-a");
        expect(started.status).toBe(200);
        expect(started.payload.result).toMatchObject({ ok: true, topic: "Release plan", status: "active" });
        const meetingId = started.payload.result!.meetingId;

        const ended = await host.callTool<{ status: string; summary: string }>("end_meeting", { meetingId, summary: "shipped" }, "ide-b");
        expect(ended.payload.result).toMatchObject({ status: "closed", summary: "shipped" });

        const archived = await host.callTool<{ status: string }>("archive_meeting", { meetingId }, "ide-b");
        expect(archived.payload.result?.status).toBe("archived");

        const reopened = await host.callTool<{ status: string }>("reopen_meeting", { meetingId }, "ide-b");
        expect(reopened.payload.result?.status).toBe("active");
        expect((await listed()).meetings.find((m) => m.id === meetingId)?.status).toBe("active");

        await host.callTool("end_meeting", { meetingId }, "ide-a");
        expect((await host.callTool("archive_meeting", { meetingId: "no-such-meeting" }, "ide-a")).status).toBe(400);
        const noActive = await host.callTool("end_meeting", {}, "ide-a");
        expect(noActive.status).toBe(400);
        expect(noActive.payload.error).toContain("No active meeting");
    });

    it("routes send_message to the active meeting, an explicit meeting, or global chat", async () => {
        const meetingId = await start("Routing", "ide-a");

        // An active meeting receives messages without any prior setup.
        const toActive = await host.callTool<{ sentTo: string; meetingId: string }>("send_message", { message: "hello" }, "ide-b");
        expect(toActive.payload.result).toMatchObject({ sentTo: "meeting", meetingId });

        await host.callTool("end_meeting", { meetingId }, "ide-a");

        const toGlobal = await host.callTool<{ sentTo: string }>("send_message", { message: "after" }, "ide-b");
        expect(toGlobal.payload.result?.sentTo).toBe("global");

        const toClosed = await host.callTool("send_message", { message: "late", meetingId }, "ide-b");
        expect(toClosed.status).toBe(400);
        expect(toClosed.payload.error).toContain("closed");

        const unread = await host.callTool<{ count: number }>("read_messages", { meetingId, count: 10 }, "ide-c");
        expect(unread.payload.result?.count).toBe(1);
    });

    it("lists meetings with counts, summary and status filter", async () => {
        const a = await start("First", "ide-a");
        await host.callTool("send_message", { message: "p", category: "PROPOSAL" }, "ide-b");
        await host.callTool("send_message", { message: "d", category: "DECISION" }, "ide-a");
        await host.callTool("end_meeting", { meetingId: a, summary: "agreed" }, "ide-a");
        const b = await start("Second", "ide-b");

        const all = await listed();
        expect(all.activeMeetingId).toBe(b);
        const first = all.meetings.find((m) => m.id === a)!;
        expect(first).toMatchObject({ status: "closed", messageCount: 2, decisionCount: 1, summary: "agreed" });
        expect([...first.participants].sort()).toEqual(["ide-a", "ide-b"]);

        const active = await listed({ status: "active", limit: 5 });
        expect(active.meetings.map((m) => m.id)).toEqual([b]);
        expect(active.count).toBe(1);

        await host.callTool("end_meeting", { meetingId: b }, "ide-b");
        expect((await listed()).activeMeetingId).toBeNull();
    });
});

describe("meetings per conversation", () => {
    const kit = agentKit(host);
    afterEach(() => kit.endSessions());
    type Read = { identity: string; messages: { text: string; from: string; senderName: string | null }[] };

    it("gives two Claude conversations on one adapter instance their own cursors and names them as senders", async () => {
        const s = ids();
        const [a, b] = [s("a"), s("b")];
        for (const id of [a, b]) await kit.hook("claude", "SessionStart", id);
        const meetingId = await start("Per session", "ide-a");
        for (const message of ["one", "two"]) expect((await host.callTool("send_message", { message, meetingId }, "ide-a")).status).toBe(200);

        // Both conversations share the claudeTool instance and each read every message.
        for (const id of [a, b]) {
            const res = await kit.claudeTool<Read>(id, "read_messages", { meetingId });
            expect(res.status, res.body).toBe(200);
            expect(res.payload.result!.identity).toBe("session");
            expect(res.payload.result!.messages.map((m) => m.text)).toEqual(["one", "two"]);
        }

        const sent = await kit.claudeTool<{ sentTo: string; identity: string; messageId: number }>(a, "send_message", { message: "from a", meetingId });
        expect(sent.payload.result).toMatchObject({ sentTo: "meeting", identity: "session", messageId: expect.any(Number) });
        const forB = (await kit.claudeTool<Read>(b, "read_messages", { meetingId })).payload.result!;
        expect(forB.messages).toEqual([expect.objectContaining({ text: "from a", from: `claude:${a}`, senderName: expect.any(String) })]);
        expect((await kit.claudeTool<Read>(a, "read_messages", { meetingId })).payload.result!.messages).toEqual([]);

        const meeting = (await listed()).meetings.find((m) => m.id === meetingId)!;
        expect(meeting.participants).toEqual(["ide-a", `claude:${a}`]);
        await host.callTool("end_meeting", { meetingId }, "ide-a");
    });
});
