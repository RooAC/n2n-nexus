/**
 * `n2n-nexus install <claude|codex> [--endpoint <url>] [--node <path>]` and
 * `n2n-nexus uninstall <claude|codex>`: register the hooks and the MCP server
 * with Claude Code or Codex. Our hook entries are recognised by a command that
 * contains both `n2n-nexus` and ` hook <client>`; everything else in the
 * configuration file is kept as it is.
 *
 * The commands start with an absolute Node path: GUI clients started from the
 * Dock do not read the shell PATH. The `node` found on PATH is preferred when it
 * is the running binary, because process.execPath is the resolved, versioned
 * location (nvm, Homebrew Cellar, ...) that disappears when Node is upgraded.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    CLAUDE_PRE_TOOL_MATCHER, HOOK_STOP_TIMEOUT_SEC, HOOK_TIMEOUT_SEC, MCP_SERVER_NAME, isHookClient,
    type HookClient
} from "../daemon/hook-contract.js";
import { pkg } from "../config/index.js";
import { entryScript } from "./autostart.js";
import { mcpConfigFile, readMcpCommand } from "./mcp-config.js";

type HookEntry = { type: "command"; command: string; commandWindows?: string; timeout: number };
export type HookGroup = { matcher?: string; hooks?: unknown[] } & Record<string, unknown>;
export type HooksFile = { hooks?: Record<string, unknown> } & Record<string, unknown>;

const EVENTS: Record<HookClient, string[]> = {
    claude: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
    codex: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "Stop"]
};

export type InstallOptions = {
    action: "install" | "uninstall";
    client: HookClient;
    endpoint?: string;
    /** Entry script written into the commands; defaults to this package's build/index.js. */
    entry?: string;
    /** Node path written into the commands (`--node`); defaults to the `node` on PATH or process.execPath. */
    node?: string;
};

export class InstallError extends Error {}

/** Path segments of Node installs that are replaced on upgrade. */
export const VERSIONED_NODE_DIR = /[/\\]Cellar[/\\]|[/\\]\.nvm[/\\]versions[/\\]|[/\\]node-v\d|[/\\]fnm[/\\]|[/\\]fnm_multishells[/\\]|[/\\]\.volta[/\\]|[/\\]\.asdf[/\\]installs[/\\]/;
/** fnm puts a per-shell symlink directory first on PATH; it is gone when the shell ends. */
const PER_SHELL_NODE_DIR = /[/\\]fnm_multishells[/\\]/;

function sameFile(a: string, b: string): boolean {
    try {
        return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
        return false;
    }
}

/**
 * The `node` on PATH when it is the running binary (its stable entry), else
 * process.execPath. Relative PATH entries and fnm's per-shell directory are
 * skipped: the commands must work from any directory and after the shell ends.
 */
export function stableNodePath(env: NodeJS.ProcessEnv = process.env): string {
    for (const dir of (env.PATH ?? "").split(path.delimiter)) {
        if (!path.isAbsolute(dir) || PER_SHELL_NODE_DIR.test(dir)) continue;
        const candidate = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
        if (sameFile(candidate, process.execPath)) return candidate;
    }
    return process.execPath;
}

type Version = [number, number, number];

export function parseVersion(text: string): Version | undefined {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const atLeast = (v: Version, min: Version) =>
    v[0] !== min[0] ? v[0] > min[0] : v[1] !== min[1] ? v[1] > min[1] : v[2] >= min[2];

/** Whether `version` satisfies the package's engines.node range (`^a.b.c` and `>=a.b.c` clauses joined by `||`). */
export function satisfiesEngines(version: string, range: string = pkg.engines.node): boolean {
    const v = parseVersion(version);
    if (!v) return false;
    return range.split("||").some((clause) => {
        const m = /^\s*(\^|>=)\s*v?(\d+\.\d+\.\d+)\s*$/.exec(clause);
        const min = m && parseVersion(m[2]);
        if (!m || !min) throw new Error(`Unsupported engines.node clause: ${clause.trim()}`);
        return atLeast(v, min) && (m[1] === ">=" || v[0] === min[0]);
    });
}

/** Check a `--node` path: it must exist, run, and satisfy engines.node. Returns the absolute path. */
function checkNodePath(given: string): string {
    const node = path.resolve(given);
    try {
        fs.accessSync(node, fs.constants.X_OK);
    } catch {
        throw new InstallError(`--node ${given}: not an executable file.`);
    }
    if (fs.statSync(node).isDirectory()) throw new InstallError(`--node ${given}: is a directory, not the node executable.`);
    const probe = spawnSync(node, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const version = probe.status === 0 ? parseVersion(probe.stdout) : undefined;
    if (!version) throw new InstallError(`--node ${given}: "${node} --version" did not print a Node version.`);
    if (!satisfiesEngines(probe.stdout)) {
        throw new InstallError(`--node ${given}: Node ${probe.stdout.trim()} does not satisfy ${pkg.engines.node}.`);
    }
    return node;
}

export function configFile(client: HookClient): string {
    if (client === "claude") {
        return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
    }
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json");
}

export function isOurs(entry: unknown, client: HookClient): boolean {
    if (typeof entry !== "object" || entry === null) return false;
    const command = (entry as { command?: unknown }).command;
    return typeof command === "string" && command.includes("n2n-nexus") && command.includes(` hook ${client}`);
}

export function readConfig(file: string): HooksFile {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new InstallError(`${file} is not valid JSON (${(error as Error).message}); fix it and run again.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new InstallError(`${file} does not contain a JSON object; fix it and run again.`);
    }
    const config = parsed as HooksFile;
    if (config.hooks !== undefined && (typeof config.hooks !== "object" || config.hooks === null || Array.isArray(config.hooks))) {
        throw new InstallError(`"hooks" in ${file} is not an object; fix it and run again.`);
    }
    return config;
}

/** Remove our entries; groups and event arrays emptied by the removal go too. Returns whether anything was removed. */
function removeOurEntries(config: HooksFile, client: HookClient, file: string): boolean {
    const hooks = config.hooks;
    if (!hooks) return false;
    let changed = false;
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) throw new InstallError(`hooks.${event} in ${file} is not an array; fix it and run again.`);
        let removed = false;
        const kept = groups.filter((group: unknown) => {
            const entries = (group as HookGroup | null)?.hooks;
            if (!Array.isArray(entries)) return true;
            const remaining = entries.filter((entry) => !isOurs(entry, client));
            if (remaining.length === entries.length) return true;
            removed = true;
            (group as HookGroup).hooks = remaining;
            return remaining.length > 0;
        });
        if (!removed) continue;
        changed = true;
        if (kept.length > 0) hooks[event] = kept;
        else delete hooks[event];
    }
    return changed;
}

function addOurEntries(config: HooksFile, client: HookClient, command: string, commandWindows?: string): void {
    const hooks = (config.hooks ??= {});
    for (const event of EVENTS[client]) {
        const entry: HookEntry = { type: "command", command, timeout: event === "Stop" ? HOOK_STOP_TIMEOUT_SEC : HOOK_TIMEOUT_SEC };
        if (commandWindows) entry.commandWindows = commandWindows;
        const group: HookGroup = client === "claude" && event === "PreToolUse"
            ? { matcher: CLAUDE_PRE_TOOL_MATCHER, hooks: [entry] }
            : { hooks: [entry] };
        const groups = hooks[event];
        if (Array.isArray(groups)) groups.push(group);
        else hooks[event] = [group];
    }
}

function writeConfig(file: string, config: HooksFile): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(tmp, file);
}

function mcpRemoveArgs(client: HookClient): string[] {
    return client === "claude"
        ? ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME]
        : ["mcp", "remove", MCP_SERVER_NAME];
}

function mcpAddArgs(client: HookClient, node: string, entry: string, endpoint?: string): string[] {
    const env = endpoint ? [client === "claude" ? "-e" : "--env", `NEXUS_ENDPOINT=${endpoint}`] : [];
    const scope = client === "claude" ? ["--scope", "user"] : [];
    return ["mcp", "add", ...scope, MCP_SERVER_NAME, ...env, "--", node, entry, "mcp"];
}

/**
 * Run `<client> mcp remove`. A failure is ignored only when `<client> mcp get`
 * shows the server is not registered (never installed, or already removed);
 * otherwise the removal really failed and we stop before `mcp add`.
 */
function removeMcpServer(client: HookClient, action: InstallOptions["action"], hooksRemoved: boolean): void {
    const removeArgs = mcpRemoveArgs(client);
    try {
        execFileSync(client, removeArgs, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
        if (action === "uninstall") process.stdout.write(`Ran: ${client} ${removeArgs.join(" ")}\n`);
        return;
    } catch (error) {
        // "Not registered" is the one failure to ignore; the registration is read from the
        // client's configuration file (an unreadable file counts as still registered).
        let registered = true;
        try {
            registered = readMcpCommand(client, mcpConfigFile(client)) !== undefined;
        } catch {
            // Keep registered = true: the error below tells the user what to look at.
        }
        if (!registered) return;
        const failure = error as { stderr?: unknown; status?: number | null; message: string };
        const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
        const detail = stderr || (typeof failure.status === "number" ? `exit code ${failure.status}` : failure.message);
        const state = action === "uninstall"
            ? `${hooksRemoved ? "The hooks were removed; t" : "T"}he MCP server is still registered in ${mcpConfigFile(client)}.`
            : "The hooks were written; the existing MCP server registration was left unchanged.";
        throw new InstallError(`"${client} ${removeArgs.join(" ")}" failed: ${detail}\n${state} Fix the error and run "n2n-nexus ${action} ${client}" again.`);
    }
}

/** Install or uninstall; prints what it did and returns the exit code. */
export function runInstall(options: InstallOptions): number {
    const { action, client, endpoint } = options;
    const entry = options.entry ?? entryScript();
    try {
        if (action === "install" && entry.includes("/_npx/")) {
            throw new InstallError(`n2n-nexus is running from an npx cache (${entry}), which can be cleared at any time. Install it first: npm i -g n2n-nexus`);
        }
        const probe = spawnSync(client, ["--version"], { stdio: "ignore" });
        if (probe.error || probe.status !== 0) {
            throw new InstallError(`The "${client}" command was not found on PATH; install ${client === "claude" ? "Claude Code" : "Codex"} first.`);
        }
        const node = action === "install" ? (options.node ? checkNodePath(options.node) : stableNodePath()) : undefined;

        const file = configFile(client);
        const config = readConfig(file);
        const removed = removeOurEntries(config, client, file);
        if (action === "install") {
            const command = `"${node}" "${entry}" hook ${client}${endpoint ? ` --endpoint ${endpoint}` : ""}`;
            const commandWindows = client === "codex"
                ? `& ${[node!, entry, "hook", client, ...(endpoint ? ["--endpoint", endpoint] : [])].map((arg) => `'${arg.replace(/['\u2018\u2019]/g, "$&$&")}'`).join(" ")}`
                : undefined;
            addOurEntries(config, client, command, commandWindows);
        }
        if (action === "install" || removed) {
            writeConfig(file, config);
            process.stdout.write(`${action === "install" ? "Wrote hooks to" : "Removed hooks from"} ${file}\n`);
        }

        removeMcpServer(client, action, removed);
        if (action === "install" && node) {
            const addArgs = mcpAddArgs(client, node, entry, endpoint);
            execFileSync(client, addArgs, { stdio: ["ignore", "ignore", "inherit"] });
            process.stdout.write(`Ran: ${client} ${addArgs.join(" ")}\n`);
            process.stdout.write(`Node: ${node}\n`);
            if (VERSIONED_NODE_DIR.test(node)) {
                process.stdout.write(`Note: this Node path contains a version directory that an upgrade may remove. After upgrading Node, run "n2n-nexus install ${client}" again, or install with --node <path> pointing at a stable entry such as /usr/local/bin/node.\n`);
            }
            if (client === "codex") {
                process.stdout.write("Next: open Codex and run /hooks to trust the n2n-nexus hooks; until then they do not run.\n");
            }
        }
        return 0;
    } catch (error) {
        process.stderr.write(`[n2n-nexus] ${action} failed: ${(error as Error).message}\n`);
        return 1;
    }
}

/** Parse `<claude|codex> [--endpoint <url>] [--node <path>]` and run. */
export function runInstallCommand(action: "install" | "uninstall", argv: string[]): number {
    const client = argv[0];
    if (!isHookClient(client)) {
        process.stderr.write(`Usage: n2n-nexus ${action} <claude|codex>${action === "install" ? " [--endpoint <url>] [--node <path>]" : ""}\n`);
        return 1;
    }
    const option = (name: string, what: string): string | undefined | null => {
        const i = argv.indexOf(name);
        if (i === -1 || action !== "install") return undefined;
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) {
            process.stderr.write(`${name} needs ${what}\n`);
            return null;
        }
        return value;
    };
    const endpoint = option("--endpoint", "a URL");
    if (endpoint === null) return 1;
    const node = option("--node", "a path");
    if (node === null) return 1;
    return runInstall({ action, client, endpoint, node });
}
