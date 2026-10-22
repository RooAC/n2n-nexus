import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runInstall } from "../src/cli/install.js";

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        spawnSync: vi.fn((...args: Parameters<typeof actual.spawnSync>) =>
            args[0] === "codex" || args[0] === "claude"
                ? { status: 0, stdout: "", stderr: "" }
                : actual.spawnSync(...args)),
        execFileSync: vi.fn()
    };
});

let dir: string;
let entry: string;
const endpoint = "http://127.0.0.1:5688/?label=$nexus&quote='";

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2n-nexus $user's-"));
    entry = path.join(dir, "entry \u2018O\u2019Connor script.cjs");
    fs.writeFileSync(entry, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: require('node:fs').readFileSync(0, 'utf8') }));");
    vi.stubEnv("CODEX_HOME", dir);
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
});

afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
});

type Entry = { command: string; commandWindows?: string };
function install(client: "codex" | "claude"): Entry[] {
    expect(runInstall({ action: "install", client, node: process.execPath, entry, endpoint })).toBe(0);
    const file = path.join(dir, client === "codex" ? "hooks.json" : "settings.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, Array<{ hooks: Entry[] }>> };
    return Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
}

describe("Codex Windows hooks", () => {
    it("writes a PowerShell command for every Codex lifecycle event", () => {
        const entries = install("codex");
        expect(entries).toHaveLength(5);
        for (const hook of entries) {
            expect(hook.commandWindows).toMatch(/^& '/);
            expect(hook.commandWindows).toContain("$user''s-");
            expect(hook.commandWindows).toContain("'hook' 'codex' '--endpoint' 'http://127.0.0.1:5688/?label=$nexus&quote='''");
            expect(hook.command).toBe(`"${process.execPath}" "${entry}" hook codex --endpoint ${endpoint}`);
        }
    });

    it("leaves Claude hook commands unchanged", () => {
        for (const hook of install("claude")) expect(hook.commandWindows).toBeUndefined();
    });

    it.runIf(process.platform === "win32")("executes the installed command in Windows PowerShell with literal arguments and stdin", () => {
        const hook = install("codex")[0];
        const script = path.join(dir, "hook.ps1");
        fs.writeFileSync(script, "\uFEFF" + hook.commandWindows!);
        const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "installation-test" });
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", input });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ args: ["hook", "codex", "--endpoint", endpoint], input });
    });
});
