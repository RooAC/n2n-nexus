import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";

import { SqliteMeetingStore } from "../src/storage/sqlite-meeting.js";
import { closeDatabase } from "../src/storage/sqlite.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "message-cursor");

describe("Message Cursor Multi-Instance Behavior", () => {
    beforeEach(async () => {
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        closeDatabase();
    });

    it("should return unread messages for same meeting per instance cursor", async () => {
        const meeting = SqliteMeetingStore.startMeeting("Cursor Meeting", "IDE-A");

        SqliteMeetingStore.addMessage(meeting.id, {
            timestamp: new Date().toISOString(),
            from: "IDE-A",
            text: "A: hello",
            category: "UPDATE"
        });

        const first = SqliteMeetingStore.getRecentMessages(10, meeting.id, "IDE-B");
        expect(first).toHaveLength(1);

        SqliteMeetingStore.addMessage(meeting.id, {
            timestamp: new Date().toISOString(),
            from: "IDE-C",
            text: "B: update",
            category: "UPDATE"
        });

        const second = SqliteMeetingStore.getRecentMessages(10, meeting.id, "IDE-B");
        expect(second).toHaveLength(1);

        const third = SqliteMeetingStore.getRecentMessages(10, meeting.id, "IDE-B");
        expect(third).toHaveLength(0);
    });
});
