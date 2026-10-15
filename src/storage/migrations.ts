import { promises as fs } from "node:fs";
import path from "node:path";
import { NexusPaths } from "./paths.js";
import { GlobalMessageStore } from "./global-messages.js";
import { DocStorage } from "./docs.js";
import { BLUEPRINT_PLACEHOLDER } from "./index.js";
import { getDatabase } from "./sqlite.js";
import { MESSAGE_CATEGORIES, MessageCategory } from "../types.js";
import { FILE_ENCODING } from "../constants.js";

/**
 * One-time upgrades of data written by earlier releases. Each step is
 * idempotent: it runs only while the legacy artifact is present and the
 * new location is still empty, then renames the artifact out of the way.
 */

/** 0.5.0 kept the global chat in global/discussion.json; import it into SQLite. */
export async function importLegacyDiscussion(): Promise<number> {
    const file = path.join(NexusPaths.globalDir, "discussion.json");
    let raw: string;
    try {
        raw = await fs.readFile(file, FILE_ENCODING);
    } catch {
        return 0;
    }
    if (GlobalMessageStore.count() > 0) return 0;

    let entries: unknown;
    try {
        entries = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
        console.warn(`[n2n-nexus] Skipping unreadable legacy chat log: ${file}`);
        return 0;
    }
    if (!Array.isArray(entries)) return 0;

    const insert = getDatabase().prepare(
        "INSERT INTO global_messages (sender, text, category, timestamp) VALUES (?, ?, ?, ?)"
    );
    const imported = getDatabase().transaction((rows: unknown[]) => {
        let n = 0;
        for (const row of rows) {
            if (!row || typeof row !== "object") continue;
            const e = row as { from?: unknown; text?: unknown; category?: unknown; timestamp?: unknown };
            if (typeof e.text !== "string") continue;
            const category = (MESSAGE_CATEGORIES as readonly string[]).includes(String(e.category)) ? e.category as MessageCategory : null;
            insert.run(
                typeof e.from === "string" && e.from ? e.from : "unknown",
                e.text,
                category,
                typeof e.timestamp === "string" && e.timestamp ? e.timestamp : new Date().toISOString()
            );
            n++;
        }
        return n;
    })(entries);

    await fs.rename(file, `${file}.migrated`);
    console.error(`[n2n-nexus] Imported ${imported} legacy global messages from discussion.json`);
    return imported;
}

/** Title 0.5.0's update_global_strategy gave the doc it wrote; a user doc with another title is left alone. */
export const LEGACY_STRATEGY_TITLE = "Global Collaboration Strategy";

/**
 * 0.5.0's update_global_strategy saved the strategy as the global doc
 * "strategy"; it now lives in global/blueprint.md. Move it there unless the
 * blueprint has already been written.
 */
export async function importLegacyStrategy(): Promise<boolean> {
    const docs = await DocStorage.listDocs();
    if (docs.strategy?.title !== LEGACY_STRATEGY_TITLE) return false;
    const legacy = await DocStorage.getDoc("strategy");
    const current = await DocStorage.getBlueprint();
    if (legacy && (!current || current === BLUEPRINT_PLACEHOLDER)) {
        await DocStorage.saveBlueprint(legacy);
    }
    await DocStorage.deleteDoc("strategy");
    console.error("[n2n-nexus] Moved legacy global doc 'strategy' into global/blueprint.md");
    return true;
}

export async function runMigrations(): Promise<void> {
    await importLegacyDiscussion();
    await importLegacyStrategy();
}
