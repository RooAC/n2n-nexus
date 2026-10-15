import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

import { GlobalMessageStore } from "../src/storage/global-messages.js";
import { EventStore } from "../src/storage/events.js";
import { closeDatabase, initDatabase } from "../src/storage/sqlite.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "global-messages");

describe("GlobalMessageStore", () => {
    beforeEach(async () => {
        closeDatabase();
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        initDatabase();
    });
    afterEach(() => closeDatabase());

    it("returns only unread messages per instance and advances the cursor", () => {
        GlobalMessageStore.addMessage("A", "one", "UPDATE");
        GlobalMessageStore.addMessage("B", "two");

        const first = GlobalMessageStore.readUnread("reader", 10);
        expect(first.map((m) => m.text)).toEqual(["one", "two"]);
        expect(first[0].category).toBe("UPDATE");

        expect(GlobalMessageStore.readUnread("reader", 10)).toHaveLength(0);
        expect(GlobalMessageStore.readUnread("other-reader", 10)).toHaveLength(2);

        GlobalMessageStore.addMessage("A", "three");
        expect(GlobalMessageStore.readUnread("reader", 10).map((m) => m.text)).toEqual(["three"]);
    });

    it("honours the count limit without skipping messages", () => {
        for (let i = 0; i < 5; i++) GlobalMessageStore.addMessage("A", `m${i}`);
        expect(GlobalMessageStore.readUnread("r", 2).map((m) => m.text)).toEqual(["m0", "m1"]);
        expect(GlobalMessageStore.readUnread("r", 2).map((m) => m.text)).toEqual(["m2", "m3"]);
        expect(GlobalMessageStore.readUnread("r", 2).map((m) => m.text)).toEqual(["m4"]);
    });

    it("prunes the oldest messages and clears all", () => {
        for (let i = 0; i < 3; i++) GlobalMessageStore.addMessage("A", `m${i}`);
        expect(GlobalMessageStore.pruneOldest(1)).toBe(1);
        expect(GlobalMessageStore.recent(10).map((m) => m.text)).toEqual(["m1", "m2"]);
        expect(GlobalMessageStore.clear()).toBe(2);
        expect(GlobalMessageStore.count()).toBe(0);
    });
});

describe("EventStore", () => {
    beforeEach(async () => {
        closeDatabase();
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        initDatabase();
    });
    afterEach(() => closeDatabase());

    it("records structured events and filters by action prefix", () => {
        EventStore.record("ide-a", "project.sync", "web_x");
        EventStore.record("ide-a", "meeting.end", "m1", { summary: "done" });
        EventStore.record("ide-b", "project.rename", "web_y", { oldId: "web_x" });

        const all = EventStore.list(10);
        expect(all.map((e) => e.action)).toEqual(["project.rename", "meeting.end", "project.sync"]);
        expect(all[1].detail).toEqual({ summary: "done" });

        expect(EventStore.list(10, "project").map((e) => e.target)).toEqual(["web_y", "web_x"]);
        expect(EventStore.list(10, "meeting.end")).toHaveLength(1);
    });
});
