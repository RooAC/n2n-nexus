import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

import { importLegacyDiscussion, importLegacyStrategy } from "../src/storage/migrations.js";
import { GlobalMessageStore } from "../src/storage/global-messages.js";
import { DocStorage } from "../src/storage/docs.js";
import { BLUEPRINT_PLACEHOLDER } from "../src/storage/index.js";
import { closeDatabase, initDatabase } from "../src/storage/sqlite.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "migrations");

describe("Legacy data migrations", () => {
    beforeEach(async () => {
        closeDatabase();
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(path.join(TEST_ROOT, "global"), { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        initDatabase();
    });
    afterEach(() => closeDatabase());

    it("imports discussion.json into global_messages once and renames the file", async () => {
        const file = path.join(TEST_ROOT, "global", "discussion.json");
        await fs.writeFile(file, JSON.stringify([
            { timestamp: "2026-01-01T00:00:00.000Z", from: "SYSTEM", text: "Session Context set", category: "SYSTEM" },
            { timestamp: "2026-01-01T00:00:01.000Z", from: "ide-a", text: "hello", category: "UPDATE" },
            { text: "no meta" },
            "garbage"
        ]));

        expect(await importLegacyDiscussion()).toBe(3);
        const messages = GlobalMessageStore.readUnread("reader", 10);
        expect(messages.map((m) => [m.from, m.text, m.category])).toEqual([
            ["SYSTEM", "Session Context set", undefined],
            ["ide-a", "hello", "UPDATE"],
            ["unknown", "no meta", undefined]
        ]);
        await expect(fs.access(file)).rejects.toThrow();
        await expect(fs.access(`${file}.migrated`)).resolves.toBeUndefined();

        expect(await importLegacyDiscussion()).toBe(0);
    });

    it("does nothing when there is no legacy file", async () => {
        expect(await importLegacyDiscussion()).toBe(0);
        expect(await importLegacyStrategy()).toBe(false);
    });

    it("moves the legacy 'strategy' global doc into blueprint.md unless a real blueprint exists", async () => {
        await DocStorage.saveBlueprint(BLUEPRINT_PLACEHOLDER);
        await DocStorage.saveDoc("strategy", "Global Collaboration Strategy", "# Real strategy", "ide-a");
        expect(await importLegacyStrategy()).toBe(true);
        expect(await DocStorage.getBlueprint()).toBe("# Real strategy");
        expect((await DocStorage.listDocs()).strategy).toBeUndefined();

        await DocStorage.saveDoc("strategy", "Old", "# Older strategy", "ide-a");
        expect(await importLegacyStrategy()).toBe(true);
        expect(await DocStorage.getBlueprint()).toBe("# Real strategy");
        expect((await DocStorage.listDocs()).strategy).toBeUndefined();
    });
});
