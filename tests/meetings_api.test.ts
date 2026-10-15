import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";

describe("Meeting lifecycle through the daemon", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("meetings-api"); });
    afterEach(async () => { await daemon.close(); });

    it("start → end → archive → reopen, with initiator-only permissions", async () => {
        const started = await daemon.callTool<{ meetingId: string }>("start_meeting", { topic: "Release plan" }, "ide-a");
        expect(started.status).toBe(200);
        const meetingId = started.payload.result!.meetingId;

        const endByOther = await daemon.callTool("end_meeting", { meetingId }, "ide-b");
        expect(endByOther.status).toBe(400);
        expect(endByOther.payload.error).toContain("Only initiator");

        const ended = await daemon.callTool<{ status: string }>("end_meeting", { meetingId, summary: "shipped" }, "ide-a");
        expect(ended.payload.result?.status).toBe("closed");

        const reopenByOther = await daemon.callTool("reopen_meeting", { meetingId }, "ide-b");
        expect(reopenByOther.status).toBe(400);
        expect(reopenByOther.payload.error).toContain("Only initiator");

        const archived = await daemon.callTool<{ status: string }>("archive_meeting", { meetingId }, "ide-a");
        expect(archived.payload.result?.status).toBe("archived");

        const reopened = await daemon.callTool<{ status: string }>("reopen_meeting", { meetingId }, "ide-a");
        expect(reopened.payload.result?.status).toBe("active");

        const meeting = await daemon.request<{ status: string; participants: string[] }>("GET", `/api/meetings/${meetingId}`);
        expect(meeting.payload.status).toBe("active");
    });

    it("routes send_message to the active meeting, an explicit meeting, or global chat", async () => {
        const started = await daemon.callTool<{ meetingId: string }>("start_meeting", { topic: "Routing" }, "ide-a");
        const meetingId = started.payload.result!.meetingId;

        // No register_session_context needed: an active meeting receives the message.
        const toActive = await daemon.callTool<{ sentTo: string; meetingId: string }>("send_message", { message: "hello" }, "ide-b");
        expect(toActive.payload.result).toMatchObject({ sentTo: "meeting", meetingId });

        await daemon.callTool("end_meeting", { meetingId }, "ide-a");

        const toGlobal = await daemon.callTool<{ sentTo: string }>("send_message", { message: "after" }, "ide-b");
        expect(toGlobal.payload.result?.sentTo).toBe("global");

        const toClosed = await daemon.callTool("send_message", { message: "late", meetingId }, "ide-b");
        expect(toClosed.status).toBe(400);
        expect(toClosed.payload.error).toContain("closed");

        const unread = await daemon.callTool<{ count: number }>("read_messages", { meetingId, count: 10 }, "ide-c");
        expect(unread.payload.result?.count).toBe(1);
    });
});
