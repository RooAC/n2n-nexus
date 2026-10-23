import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { cleanupExecutables, executablePath, writeExecutable } from "./helpers/executable.js";

import { runInstall, satisfiesEngines } from "../src/cli/install.js";

// Runs the built CLI: beforeAll runs `npm run build` so build/ matches the sources.
const REPO = path.resolve(__dirname, "..");
const ENTRY = path.join(REPO, "build", "index.js");
const TMP = path.join(REPO, "tests", "tmp", "install");
const NODE = process.execPath;
const command = (client: string, endpoint?: string, node = NODE) => `"${node}" "${ENTRY}" hook ${client}${endpoint ? ` --endpoint ${endpoint}` : ""}`;
const codexWindowsCommand = (endpoint?: string) => `& ${[NODE, ENTRY, "hook", "codex", ...(endpoint ? ["--endpoint", endpoint] : [])].map((arg) => `'${arg.replace(/['\u2018\u2019]/g, "$&$&")}'`).join(" ")}`;

let dir: string;
let bin: string;
let claudeDir: string;
let codexHome: string;
let callsLog: string;

/** A fake claude / codex that records its arguments (tab separated, one call per line). */
function fakeCli(name: string): void {
    writeExecutable(path.join(bin, name), `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_LOG, [${JSON.stringify(name)}, ...args].join("\\t") + "\\n");
if (args[1] === "remove" && process.env.FAIL_REMOVE) {
    process.stderr.write("cannot write config: EACCES\\n");
    process.exit(1);
}
`);
}

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(NODE, [ENTRY, ...args], {
        encoding: "utf8",
        env: { SystemRoot: process.env.SystemRoot, PATH: [bin, path.join(bin, "node")].join(path.delimiter), HOME: dir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, CALLS_LOG: callsLog, ...env }
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function calls(): string[][] {
    if (!fs.existsSync(callsLog)) return [];
    return fs.readFileSync(callsLog, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => line.split("\t"));
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
/** Commands of our hook entries in a config file. */
function ourCommands(file: string, client: string): string[] {
    const hooks = readJson(file).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    // The background wait entry is the same command with --wait appended.
    return Object.values(hooks).flat().flatMap((group) => group.hooks).map((h) => h.command).filter((c) => c.includes(` hook ${client}`))
        .map((c) => c.replace(/ --wait$/, ""));
}
/** An alias to the running Node; Windows directory junctions do not need symlink privileges. */
function linkNode(relative: string): string {
    if (process.platform === "win32") {
        const junction = path.join(dir, relative);
        fs.mkdirSync(path.dirname(junction), { recursive: true });
        fs.symlinkSync(path.dirname(NODE), junction, "junction");
        return path.join(junction, path.basename(NODE));
    }
    const link = executablePath(path.join(dir, relative));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(NODE, link);
    return link;
}
const claudeSettings = () => path.join(claudeDir, "settings.json");
/** Register the MCP server the way `claude mcp add --scope user` records it. */
function registerClaudeMcp(): void {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "n2n-nexus": { command: NODE, args: [ENTRY, "mcp"] } } }));
}
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
}, 60_000); // removing the previous tree and writing the fake CLIs is slow on Windows runners

afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    cleanupExecutables();
});

describe("install claude", () => {
    it.runIf(process.platform !== "win32")("writes through a symlinked settings.json (shared between accounts) instead of replacing the link", () => {
        const shared = path.join(dir, "shared-settings.json");
        fs.writeFileSync(shared, JSON.stringify(userSettings));
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.symlinkSync(shared, claudeSettings());

        expect(run(["install", "claude"]).code).toBe(0);
        expect(fs.lstatSync(claudeSettings()).isSymbolicLink()).toBe(true);
        expect(ourCommands(shared, "claude").length).toBeGreaterThan(0);

        expect(run(["uninstall", "claude"]).code).toBe(0);
        expect(fs.lstatSync(claudeSettings()).isSymbolicLink()).toBe(true);
        expect(readJson(shared)).toEqual(userSettings);
    });

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
                Stop: [userSettings.hooks.Stop[0], { hooks: [entry(600)] }, { hooks: [{ type: "command", command: `${command("claude")} --wait`, asyncRewake: true, timeout: 3600 }] }],
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
        const ours = ourCommands(claudeSettings(), "claude");
        expect(ours).toHaveLength(7);
        for (const hook of ours) expect(hook).toBe(command("claude", "http://127.0.0.1:5799"));
        expect(calls().at(-1)).toEqual(["claude", "mcp", "add", "--scope", "user", "n2n-nexus", "-e", "NEXUS_ENDPOINT=http://127.0.0.1:5799", "--", NODE, ENTRY, "mcp"]);
    });

    it("creates settings.json when it does not exist and ignores a failing mcp remove", () => {
        const result = run(["install", "claude"], { FAIL_REMOVE: "1" });
        expect(result.code).toBe(0);
        expect(Object.keys(readJson(claudeSettings()).hooks as object).sort()).toEqual(
            ["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]
        );
        expect(calls().slice(1, 2)).toEqual([["claude", "mcp", "remove", "--scope", "user", "n2n-nexus"]]);
        expect(calls().at(-1)?.slice(0, 3)).toEqual(["claude", "mcp", "add"]);
    });

    it("install stops before mcp add when mcp remove fails and the server is still registered", () => {
        registerClaudeMcp();
        const result = run(["install", "claude"], { FAIL_REMOVE: "1" });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("[n2n-nexus] install failed:");
        expect(result.stderr).toContain("cannot write config: EACCES");
        expect(calls()).toEqual([
            ["claude", "--version"],
            ["claude", "mcp", "remove", "--scope", "user", "n2n-nexus"]
        ]);
    });

    it("uninstall fails when mcp remove fails and the server is still registered", () => {
        registerClaudeMcp();
        const result = run(["uninstall", "claude"], { FAIL_REMOVE: "1" });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("[n2n-nexus] uninstall failed:");
        expect(result.stderr).toContain("cannot write config: EACCES");
        expect(result.stderr).toContain(`MCP server is still registered in ${path.join(claudeDir, ".claude.json")}`);
        expect(calls()).toEqual([
            ["claude", "--version"],
            ["claude", "mcp", "remove", "--scope", "user", "n2n-nexus"]
        ]);
    });

    it("uninstall ignores a failing mcp remove when the server is not registered", () => {
        const result = run(["uninstall", "claude"], { FAIL_REMOVE: "1" });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(calls()).toEqual([
            ["claude", "--version"],
            ["claude", "mcp", "remove", "--scope", "user", "n2n-nexus"]
        ]);
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
        fs.rmSync(executablePath(path.join(bin, "claude")));
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

        const entry = (timeout: number) => ({ type: "command", command: command("codex", "http://127.0.0.1:5799"), commandWindows: codexWindowsCommand("http://127.0.0.1:5799"), timeout });
        expect(readJson(codexHooks())).toEqual({
            hooks: {
                SessionStart: [{ hooks: [entry(10)] }],
                SessionEnd: [{ hooks: [entry(10)] }],
                UserPromptSubmit: [{ hooks: [entry(10)] }],
                PostToolUse: [{ hooks: [entry(10)] }],
                Stop: [{ hooks: [entry(600)] }, { hooks: [{ ...entry(10), command: `${command("codex", "http://127.0.0.1:5799")} --wait`, commandWindows: `${codexWindowsCommand("http://127.0.0.1:5799")} '--wait'` }] }]
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
        expect(hooks.Stop).toEqual([
            original.hooks.Stop[0],
            { hooks: [{ type: "command", command: command("codex"), commandWindows: codexWindowsCommand(), timeout: 600 }] },
            { hooks: [{ type: "command", command: `${command("codex")} --wait`, commandWindows: `${codexWindowsCommand()} '--wait'`, timeout: 10 }] }
        ]);
        expect(hooks.PreToolUse).toBeUndefined();

        expect(run(["install", "codex"]).code).toBe(0);
        expect(fs.readFileSync(codexHooks(), "utf8")).toBe(once);

        fs.writeFileSync(callsLog, "");
        expect(run(["uninstall", "codex"]).code).toBe(0);
        expect(readJson(codexHooks())).toEqual(original);
        expect(calls()).toEqual([["codex", "--version"], ["codex", "mcp", "remove", "n2n-nexus"]]);
    });

    it("refuses when codex is not on PATH or hooks.json is broken, writing nothing", () => {
        fs.rmSync(executablePath(path.join(bin, "codex")));
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

describe("node path", () => {
    it("writes the node on PATH when it is the running binary", () => {
        const link = linkNode("bin/node");
        const result = run(["install", "claude"]);
        expect(result.code).toBe(0);
        expect(link).not.toBe(NODE);
        expect(ourCommands(claudeSettings(), "claude")).toEqual(Array(7).fill(command("claude", undefined, link)));
        expect(calls().at(-1)).toEqual(["claude", "mcp", "add", "--scope", "user", "n2n-nexus", "--", link, ENTRY, "mcp"]);
        expect(result.stdout).toContain(`Node: ${link}\n`);
    });

    it("prefers the first matching PATH entry and skips a different node", () => {
        const other = path.join(dir, "other");
        fs.mkdirSync(other);
        writeExecutable(path.join(other, "node"), "process.exit(0);");
        const link = linkNode("stable/node");
        const result = run(["install", "codex"], { PATH: [bin, other, path.dirname(link)].join(path.delimiter) });
        expect(result.code).toBe(0);
        expect(ourCommands(codexHooks(), "codex")).toEqual(Array(6).fill(command("codex", undefined, link)));
        expect(calls().at(-1)).toEqual(["codex", "mcp", "add", "n2n-nexus", "--", link, ENTRY, "mcp"]);
    });

    it("skips relative PATH entries and fnm's per-shell directory", () => {
        const relative = linkNode("cwd/node");
        const multishell = linkNode("fnm_multishells/123_456/bin/node");
        const result = spawnSync(NODE, [ENTRY, "install", "claude"], {
            cwd: path.join(dir, "cwd"),
            encoding: "utf8",
            env: { SystemRoot: process.env.SystemRoot, PATH: [path.relative(path.join(dir, "cwd"), path.dirname(relative)) || ".", path.join("..", "cwd", process.platform === "win32" ? "node" : ""), bin, path.dirname(multishell)].join(path.delimiter), HOME: dir, CLAUDE_CONFIG_DIR: claudeDir, CALLS_LOG: callsLog }
        });
        expect(result.status).toBe(0);
        expect(ourCommands(claudeSettings(), "claude")).toEqual(Array(7).fill(command("claude")));
        expect(calls().at(-1)).toEqual(["claude", "mcp", "add", "--scope", "user", "n2n-nexus", "--", NODE, ENTRY, "mcp"]);
        expect(run(["install", "codex", "--node", multishell]).stdout).toContain("--node <path>");
    });

    it("falls back to process.execPath when PATH has no node or a different one", () => {
        expect(run(["install", "claude"]).code).toBe(0);
        expect(ourCommands(claudeSettings(), "claude")).toEqual(Array(7).fill(command("claude")));

        writeExecutable(path.join(bin, "node"), "process.exit(0);");
        const result = run(["install", "claude"]);
        expect(result.code).toBe(0);
        expect(ourCommands(claudeSettings(), "claude")).toEqual(Array(7).fill(command("claude")));
        expect(calls().at(-1)).toEqual(["claude", "mcp", "add", "--scope", "user", "n2n-nexus", "--", NODE, ENTRY, "mcp"]);
        expect(result.stdout).toContain(`Node: ${NODE}\n`);
    });

    it("--node writes the given path for claude and codex", () => {
        linkNode("bin/node");
        const link = linkNode("stable/node");
        expect(run(["install", "claude", "--node", link, "--endpoint", "http://127.0.0.1:5799"]).code).toBe(0);
        expect(ourCommands(claudeSettings(), "claude")).toEqual(Array(7).fill(command("claude", "http://127.0.0.1:5799", link)));
        expect(calls().at(-1)).toEqual(["claude", "mcp", "add", "--scope", "user", "n2n-nexus", "-e", "NEXUS_ENDPOINT=http://127.0.0.1:5799", "--", link, ENTRY, "mcp"]);

        expect(run(["install", "codex", "--node", link]).code).toBe(0);
        expect(ourCommands(codexHooks(), "codex")).toEqual(Array(6).fill(command("codex", undefined, link)));
        expect(calls().at(-1)).toEqual(["codex", "mcp", "add", "n2n-nexus", "--", link, ENTRY, "mcp"]);
    });

    it("--node rejects a missing path, a directory, a non-node program and an old Node, writing nothing", () => {
        const notNode = writeExecutable(path.join(bin, "not-node"), 'process.stdout.write("hello\\n");');
        const oldNode = writeExecutable(path.join(bin, "old-node"), 'process.stdout.write("v22.13.1\\n");');
        const cases: Array<[string, string]> = [
            [path.join(dir, "missing", "node"), "not an executable file"],
            [bin, "is a directory"],
            [notNode, `"${notNode} --version" did not print a Node version`],
            [oldNode, "Node v22.13.1 does not satisfy ^22.14.0 || >=23.6.0"]
        ];
        for (const [node, message] of cases) {
            fs.rmSync(callsLog, { force: true });
            const result = run(["install", "claude", "--node", node]);
            expect(result.code, node).toBe(1);
            expect(result.stderr, node).toContain(`--node ${node}: ${message}`);
            expect(fs.existsSync(claudeDir), node).toBe(false);
            expect(calls(), node).toEqual([["claude", "--version"]]);
        }
        const result = run(["install", "claude", "--node"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("--node needs a path");
        expect(fs.existsSync(claudeDir)).toBe(false);
    });

    it("warns when the written path is inside a version directory", () => {
        const link = linkNode("node-v99.1.0/bin/node");
        const result = run(["install", "claude", "--node", link]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`Node: ${link}\n`);
        expect(result.stdout).toContain('run "n2n-nexus install claude" again, or install with --node <path>');
        expect(run(["install", "codex", "--node", linkNode("stable/node")]).stdout).not.toContain("--node <path>");
    });

    it("replaces the entries when reinstalled with another node path and uninstalls cleanly", () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(claudeSettings(), JSON.stringify(userSettings));
        const first = linkNode("node-v1.0.0/bin/node");
        const second = linkNode("stable/node");
        expect(run(["install", "claude", "--node", first]).code).toBe(0);
        expect(ourCommands(claudeSettings(), "claude")).toEqual(Array(7).fill(command("claude", undefined, first)));

        expect(run(["install", "claude", "--node", second]).code).toBe(0);
        const once = fs.readFileSync(claudeSettings(), "utf8");
        expect(ourCommands(claudeSettings(), "claude")).toEqual(Array(7).fill(command("claude", undefined, second)));
        expect(once).not.toContain(first);
        expect(run(["install", "claude", "--node", second]).code).toBe(0);
        expect(fs.readFileSync(claudeSettings(), "utf8")).toBe(once);

        fs.writeFileSync(callsLog, "");
        expect(run(["uninstall", "claude"]).code).toBe(0);
        expect(readJson(claudeSettings())).toEqual(userSettings);
        expect(calls()).toEqual([["claude", "--version"], ["claude", "mcp", "remove", "--scope", "user", "n2n-nexus"]]);
    });

    it("satisfiesEngines follows ^22.14.0 || >=23.6.0", () => {
        for (const ok of ["v22.14.0", "v22.99.1", "v23.6.0", "v24.0.0", "26.6.5\n"]) expect(satisfiesEngines(ok), ok).toBe(true);
        for (const bad of ["v22.13.9", "v23.5.9", "v21.0.0", "v20.19.0", "", "latest"]) expect(satisfiesEngines(bad), bad).toBe(false);
        expect(satisfiesEngines("v18.0.0", ">=18.0.0")).toBe(true);
        expect(() => satisfiesEngines("v18.0.0", "~18.0.0")).toThrow("Unsupported engines.node clause");
    });
});
