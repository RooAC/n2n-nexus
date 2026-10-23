import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";

import { SqliteMeetingStore } from "../src/storage/sqlite-meeting.js";
import { closeDatabase, getDatabase } from "../src/storage/sqlite.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "storage-meeting-tx");

/** Makes the write of one meeting_state key fail, as a crash between statements would. */
function failStateWrite(key: string) {
    getDatabase().exec(`
        CREATE TRIGGER fail_state_insert BEFORE INSERT ON meeting_state
        WHEN NEW.key = '${key}' BEGIN SELECT RAISE(ABORT, 'injected state failure'); END;
    `);
}

function clearFailure() {
    getDatabase().exec("DROP TRIGGER IF EXISTS fail_state_insert");
}

const meetingCount = () => (getDatabase().prepare("SELECT COUNT(*) AS n FROM meetings").get() as { n: number }).n;
const activeIds = () => JSON.parse(SqliteMeetingStore.getState("active_meetings") || "[]") as string[];

describe("Meeting state changes are atomic", () => {
    beforeEach(async () => {
        closeDatabase();
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        SqliteMeetingStore.init();
    });

    afterEach(() => {
        closeDatabase();
    });

    it("startMeeting leaves nothing behind when the active list cannot be written", () => {
        failStateWrite("active_meetings");
        expect(() => SqliteMeetingStore.startMeeting("Broken", "ide-a")).toThrow("injected state failure");
        clearFailure();

        expect(meetingCount()).toBe(0);
        expect(SqliteMeetingStore.getState("default_meeting")).toBe("");
        expect(activeIds()).toEqual([]);
    });

    it("endMeeting leaves the meeting active when the state cannot be written", () => {
        const meeting = SqliteMeetingStore.startMeeting("Keep", "ide-a");

        failStateWrite("default_meeting");
        expect(() => SqliteMeetingStore.endMeeting(meeting.id)).toThrow("injected state failure");
        clearFailure();

        expect(SqliteMeetingStore.getMeeting(meeting.id)?.status).toBe("active");
        expect(activeIds()).toEqual([meeting.id]);
        expect(SqliteMeetingStore.getActiveMeetingId()).toBe(meeting.id);
    });

    it("reopenMeeting leaves the meeting closed when the active list cannot be written", () => {
        const meeting = SqliteMeetingStore.startMeeting("Reopen", "ide-a");
        SqliteMeetingStore.endMeeting(meeting.id);

        failStateWrite("active_meetings");
        expect(() => SqliteMeetingStore.reopenMeeting(meeting.id)).toThrow("injected state failure");
        clearFailure();

        expect(SqliteMeetingStore.getMeeting(meeting.id)?.status).toBe("closed");
        expect(activeIds()).toEqual([]);
    });
});
