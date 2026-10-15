import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteMeetingStore } from "../src/storage/sqlite-meeting.js";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";

describe("Daemon messages API", () => {
    let daemon: DaemonHarness;

    beforeEach(async () => { daemon = await startTestDaemon("daemon-messages"); });
    afterEach(async () => { await daemon.close(); });

    it("supports unread cursor per instance for meeting messages", async () => {
        const meeting = SqliteMeetingStore.startMeeting("Daemon Cursor", "IDE-A");

        const firstSend = await daemon.request<{ ok: boolean; sentTo: "meeting" | "global"; meetingId?: string }>(
            "POST", "/api/messages/send", { message: "first", meetingId: meeting.id, instanceId: "IDE-B" }
        );
        expect(firstSend.status).toBe(200);
        expect(firstSend.payload.ok).toBe(true);
        expect(firstSend.payload.meetingId).toBe(meeting.id);

        const unread = () => daemon.request<{ source: string; messages: Array<{ text: string }>; count: number }>(
            "GET", `/api/messages/unread?meetingId=${encodeURIComponent(meeting.id)}&instanceId=IDE-B&count=10`
        );

        const firstRead = await unread();
        expect(firstRead.status).toBe(200);
        expect(firstRead.payload.source).toBe("meeting");
        expect(firstRead.payload.messages.map((m) => m.text)).toEqual(["first"]);

        const secondSend = await daemon.request<{ ok: boolean }>(
            "POST", "/api/messages/send", { message: "second", meetingId: meeting.id, instanceId: "IDE-C" }
        );
        expect(secondSend.payload.ok).toBe(true);

        expect((await unread()).payload.messages.map((m) => m.text)).toEqual(["second"]);
        expect((await unread()).payload.messages).toHaveLength(0);
    });
});
