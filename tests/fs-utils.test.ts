import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../src/storage/fs-utils.js";

describe("writeFileAtomic rename failures", () => {
    let root: string;
    let target: string;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-atomic-"));
        target = path.join(root, "target.json");
        await fs.writeFile(target, "original");
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        Object.defineProperty(process, "platform", platform);
        await fs.rm(root, { recursive: true, force: true });
    });

    it.each(["EPERM", "EACCES", "EBUSY"])("retries transient Windows %s without removing the original target", async (code) => {
        Object.defineProperty(process, "platform", { value: "win32" });
        const realRename = fs.rename.bind(fs);
        let attempts = 0;
        const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            expect(await fs.readFile(target, "utf8")).toBe("original");
            expect(await fs.readFile(from, "utf8")).toBe("replacement");
            if (++attempts < 3) throw Object.assign(new Error("sharing violation"), { code });
            return realRename(from, to);
        });

        await writeFileAtomic(target, "replacement");

        expect(rename).toHaveBeenCalledTimes(3);
        expect(await fs.readFile(target, "utf8")).toBe("replacement");
        expect(await fs.readdir(root)).toEqual(["target.json"]);
    });

    it("bounds persistent Windows sharing retries, preserves the target, and cleans the temporary file", async () => {
        Object.defineProperty(process, "platform", { value: "win32" });
        const error = Object.assign(new Error("sharing violation"), { code: "EPERM" });
        const rename = vi.spyOn(fs, "rename").mockRejectedValue(error);

        await expect(writeFileAtomic(target, "replacement")).rejects.toBe(error);

        expect(rename).toHaveBeenCalledTimes(5);
        expect(await fs.readFile(target, "utf8")).toBe("original");
        expect(await fs.readdir(root)).toEqual(["target.json"]);
    });

    it.each([
        ["win32", "ENOENT"],
        ["linux", "EPERM"],
        ["linux", "EACCES"],
        ["linux", "EBUSY"]
    ])("does not retry %s rename error %s", async (currentPlatform, code) => {
        Object.defineProperty(process, "platform", { value: currentPlatform });
        const error = Object.assign(new Error("rename failure"), { code });
        const rename = vi.spyOn(fs, "rename").mockRejectedValue(error);

        await expect(writeFileAtomic(target, "replacement")).rejects.toBe(error);

        expect(rename).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(target, "utf8")).toBe("original");
        expect(await fs.readdir(root)).toEqual(["target.json"]);
    });
});
