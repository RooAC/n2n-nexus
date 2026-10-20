import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { runInstall } from "../src/cli/install.js";

// Runs the built CLI: beforeAll runs `npm run build` so build/ matches the sources.
const REPO = path.resolve(__dirname, "..");
const ENTRY = path.join(REPO, "build", "index.js");
const TMP = path.join(REPO, "tests", "tmp", "install");
const NODE = process.execPath;
const command = (client: string, endpoint?: string) => `"${NODE}" "${ENTRY}" hook ${client}${endpoint ? ` --endpoint ${endpoint}` : ""}`;

let dir: string;
let bin: string;
let claudeDir: string;
let codexHome: string;
let callsLog: string;

/** A fake claude / codex that records its arguments (tab separated, one call per line). */
function fakeCli(name: string): void {
    const script = `#!/bin/sh
printf '%s' "${name}" >> "$CALLS_LOG"
for a in "$@"; do printf '\\t%s' "$a" >> "$CALLS_LOG"; done
printf '\\n' >> "$CALLS_LOG"
if [ "$2" = "remove" ] && [ -n "$FAIL_REMOVE" ]; then exit 1; fi
exit 0
`;
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
}

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(NODE, [ENTRY, ...args], {
        encoding: "utf8",
        env: { PATH: bin, HOME: dir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, CALLS_LOG: callsLog, ...env }
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function calls(): string[][] {
    if (!fs.existsSync(callsLog)) return [];
    return fs.readFileSync(callsLog, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => line.split("\t"));
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const claudeSettings = () => path.join(claudeDir, "settings.json");
const codexHooks = () => path.join(codexHome, "hooks.json");

const userSettings = {
    model: "opus",
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
        Notification: [{ hooks: [{ type: "command", command: "beep" }] }]
    }
};

beforeAll(() => {
    execSync("npm run build", { cwd: REPO, stdio: "ignore" });
}, 120_000);

beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    dir = TMP;
    bin = path.join(dir, "bin");
    claudeDir = path.join(dir, "claude");
    codexHome = path.join(dir, "codex");
    callsLog = path.join(dir, "calls.log");
    fs.mkdirSync(bin, { recursive: true });
    fakeCli("claude");
    fakeCli("codex");
});

afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
});

describe("install claude", () => {
    it("merges the hooks into existing settings and registers the MCP server", () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(claudeSettings(), JSON.stringify(userSettings));

        const result = run(["install", "claude"]);
        expect(result.code).toBe(0);

        const entry = (timeout: number) => ({ type: "command", command: command("claude"), timeout });
        expect(readJson(claudeSettings())).toEqual({
            model: "opus",
            permissions: { allow: ["Bash(ls:*)"] },
            hooks: {
                PreToolUse: [userSettings.hooks.PreToolUse[0], { matcher: "mcp__n2n-nexus__.*", hooks: [entry(10)] }],
                Stop: [userSettings.hooks.Stop[0], { hooks: [entry(600)] }],
                Notification: userSettings.hooks.Notification,
                SessionStart: [{ hooks: [entry(10)] }],
                SessionEnd: [{ hooks: [entry(10)] }],
                UserPromptSubmit: [{ hooks: [entry(10)] }],
                PostToolUse: [{ hooks: [entry(10)] }]
            }
        });
        expect(fs.readFileSync(claudeSettings(), "utf8")).toMatch(/^\{\n {2}"model"/);
        expect(calls()).toEqual([
            ["claude", "--version"],
            ["claude", "mcp", "remove", "--scope", "user", "n2n-nexus"],
            ["claude", "mcp", "add", "--scope", "user", "n2n-nexus", "--", NODE, ENTRY, "mcp"]
        ]);
        expect(result.stdout).toContain(claudeSettings());
        expect(result.stdout).toContain(`claude mcp add --scope user n2n-nexus -- ${NODE} ${ENTRY} mcp`);
        expect(fs.readdirSync(claudeDir)).toEqual(["settings.json"]);
    });

    it("gives the same result when installed twice, and replaces the endpoint", () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(claudeSettings(), JSON.stringify(userSettings));
        expect(run(["install", "claude"]).code).toBe(0);
        const once = fs.readFileSync(claudeSettings(), "utf8");
        expect(run(["install", "claude"]).code).toBe(0);
        expect(fs.readFileSync(claudeSettings(), "utf8")).toBe(once);

        expect(run(["install", "claude", "--endpoint", "http://127.0.0.1:5799"]).code).toBe(0);
        const hooks = readJson(claudeSettings()).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
        const ours = Object.values(hooks).flat().flatMap((group) => group.hooks).filter((h) => h.command.includes(" hook claude"));
        expect(ours).toHaveLength(6);
        for (const hook of ours) expect(hook.command).toBe(command("claude", "http://127.0.0.1:5799"));
        expect(calls().at(-1)).toEqual(["claude", "mcp", "add", "--scope", "user", "n2n-nexus", "-e", "NEXUS_ENDPOINT=http://127.0.0.1:5799", "--", NODE, ENTRY, "mcp"]);
    });

    it("creates settings.json when it does not exist and ignores a failing mcp remove", () => {
        const result = run(["install", "claude"], { FAIL_REMOVE: "1" });
        expect(result.code).toBe(0);
        expect(Object.keys(readJson(claudeSettings()).hooks as object).sort()).toEqual(
            ["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]
        );
        expect(calls().at(-1)?.slice(0, 3)).toEqual(["claude", "mcp", "add"]);
    });

    it("uninstall removes only our entries and the MCP server", () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(claudeSettings(), JSON.stringify(userSettings));
        expect(run(["install", "claude", "--endpoint", "http://127.0.0.1:5799"]).code).toBe(0);
        fs.writeFileSync(callsLog, "");

        const result = run(["uninstall", "claude"]);
        expect(result.code).toBe(0);
        expect(readJson(claudeSettings())).toEqual(userSettings);
        expect(calls()).toEqual([
            ["claude", "--version"],
            ["claude", "mcp", "remove", "--scope", "user", "n2n-nexus"]
        ]);
    });

    it("refuses a settings.json that is not valid JSON and writes nothing", () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(claudeSettings(), "{ broken");
        const result = run(["install", "claude"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("not valid JSON");
        expect(fs.readFileSync(claudeSettings(), "utf8")).toBe("{ broken");
        expect(fs.readdirSync(claudeDir)).toEqual(["settings.json"]);
        expect(calls()).toEqual([["claude", "--version"]]);
    });

    it("refuses to install when claude is not on PATH and writes nothing", () => {
        fs.rmSync(path.join(bin, "claude"));
        const result = run(["install", "claude"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("not found on PATH");
        expect(fs.existsSync(claudeDir)).toBe(false);
    });

    it("refuses to install from an npx cache and writes nothing", () => {
        const saved = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeDir;
        try {
            const code = runInstall({ action: "install", client: "claude", entry: "/home/u/.npm/_npx/0123abcd/node_modules/n2n-nexus/build/index.js" });
            expect(code).toBe(1);
        } finally {
            if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = saved;
        }
        expect(fs.existsSync(claudeDir)).toBe(false);
        expect(calls()).toEqual([]);
    });
});

describe("install codex", () => {
    it("writes hooks.json without PreToolUse, registers the MCP server and asks to trust the hooks", () => {
        const result = run(["install", "codex", "--endpoint", "http://127.0.0.1:5799"]);
        expect(result.code).toBe(0);

        const entry = (timeout: number) => ({ type: "command", command: command("codex", "http://127.0.0.1:5799"), timeout });
        expect(readJson(codexHooks())).toEqual({
            hooks: {
                SessionStart: [{ hooks: [entry(10)] }],
                SessionEnd: [{ hooks: [entry(10)] }],
                UserPromptSubmit: [{ hooks: [entry(10)] }],
                PostToolUse: [{ hooks: [entry(10)] }],
                Stop: [{ hooks: [entry(600)] }]
            }
        });
        expect(calls()).toEqual([
            ["codex", "--version"],
            ["codex", "mcp", "remove", "n2n-nexus"],
            ["codex", "mcp", "add", "n2n-nexus", "--env", "NEXUS_ENDPOINT=http://127.0.0.1:5799", "--", NODE, ENTRY, "mcp"]
        ]);
        expect(result.stdout).toContain(codexHooks());
        expect(result.stdout).toContain("/hooks");
    });

    it("keeps other hooks, is stable on reinstall and uninstalls cleanly", () => {
        const original = {
            hooks: {
                Stop: [{ hooks: [{ type: "command", command: "say done", timeout: 5 }] }],
                // A claude hook in the codex file is not ours to touch.
                PostToolUse: [{ hooks: [{ type: "command", command: `"${NODE}" "/opt/n2n-nexus/build/index.js" hook claude` }] }]
            }
        };
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(codexHooks(), JSON.stringify(original, null, 2) + "\n");

        expect(run(["install", "codex"]).code).toBe(0);
        const once = fs.readFileSync(codexHooks(), "utf8");
        const hooks = readJson(codexHooks()).hooks as Record<string, unknown[]>;
        expect(hooks.Stop).toEqual([original.hooks.Stop[0], { hooks: [{ type: "command", command: command("codex"), timeout: 600 }] }]);
        expect(hooks.PreToolUse).toBeUndefined();

        expect(run(["install", "codex"]).code).toBe(0);
        expect(fs.readFileSync(codexHooks(), "utf8")).toBe(once);

        fs.writeFileSync(callsLog, "");
        expect(run(["uninstall", "codex"]).code).toBe(0);
        expect(readJson(codexHooks())).toEqual(original);
        expect(calls()).toEqual([["codex", "--version"], ["codex", "mcp", "remove", "n2n-nexus"]]);
    });

    it("refuses when codex is not on PATH or hooks.json is broken, writing nothing", () => {
        fs.rmSync(path.join(bin, "codex"));
        expect(run(["install", "codex"]).code).toBe(1);
        expect(fs.existsSync(codexHome)).toBe(false);

        fakeCli("codex");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(codexHooks(), "[not json");
        expect(run(["install", "codex"]).code).toBe(1);
        expect(fs.readFileSync(codexHooks(), "utf8")).toBe("[not json");
        expect(fs.readdirSync(codexHome)).toEqual(["hooks.json"]);
    });
});
