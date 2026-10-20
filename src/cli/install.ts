/**
 * `n2n-nexus install <claude|codex> [--endpoint <url>]` and
 * `n2n-nexus uninstall <claude|codex>`: register the hooks and the MCP server
 * with Claude Code or Codex. Our hook entries are recognised by a command that
 * contains both `n2n-nexus` and ` hook <client>`; everything else in the
 * configuration file is kept as it is.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    CLAUDE_PRE_TOOL_MATCHER, HOOK_STOP_TIMEOUT_SEC, HOOK_TIMEOUT_SEC, MCP_SERVER_NAME, isHookClient,
    type HookClient
} from "../daemon/hook-contract.js";
import { entryScript } from "./autostart.js";

type HookEntry = { type: "command"; command: string; timeout: number };
type HookGroup = { matcher?: string; hooks?: unknown[] } & Record<string, unknown>;
type HooksFile = { hooks?: Record<string, unknown> } & Record<string, unknown>;

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
};

class InstallError extends Error {}

function configFile(client: HookClient): string {
    if (client === "claude") {
        return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
    }
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json");
}

function isOurs(entry: unknown, client: HookClient): boolean {
    if (typeof entry !== "object" || entry === null) return false;
    const command = (entry as { command?: unknown }).command;
    return typeof command === "string" && command.includes("n2n-nexus") && command.includes(` hook ${client}`);
}

function readConfig(file: string): HooksFile {
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

function addOurEntries(config: HooksFile, client: HookClient, command: string): void {
    const hooks = (config.hooks ??= {});
    for (const event of EVENTS[client]) {
        const entry: HookEntry = { type: "command", command, timeout: event === "Stop" ? HOOK_STOP_TIMEOUT_SEC : HOOK_TIMEOUT_SEC };
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

function mcpAddArgs(client: HookClient, entry: string, endpoint?: string): string[] {
    const env = endpoint ? [client === "claude" ? "-e" : "--env", `NEXUS_ENDPOINT=${endpoint}`] : [];
    const scope = client === "claude" ? ["--scope", "user"] : [];
    return ["mcp", "add", ...scope, MCP_SERVER_NAME, ...env, "--", process.execPath, entry, "mcp"];
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

        const file = configFile(client);
        const config = readConfig(file);
        const removed = removeOurEntries(config, client, file);
        if (action === "install") {
            const command = `"${process.execPath}" "${entry}" hook ${client}${endpoint ? ` --endpoint ${endpoint}` : ""}`;
            addOurEntries(config, client, command);
        }
        if (action === "install" || removed) {
            writeConfig(file, config);
            process.stdout.write(`${action === "install" ? "Wrote hooks to" : "Removed hooks from"} ${file}\n`);
        }

        const removeArgs = mcpRemoveArgs(client);
        try {
            execFileSync(client, removeArgs, { stdio: "ignore" });
            if (action === "uninstall") process.stdout.write(`Ran: ${client} ${removeArgs.join(" ")}\n`);
        } catch {
            // Not registered yet (or already removed): nothing to undo.
        }
        if (action === "install") {
            const addArgs = mcpAddArgs(client, entry, endpoint);
            execFileSync(client, addArgs, { stdio: ["ignore", "ignore", "inherit"] });
            process.stdout.write(`Ran: ${client} ${addArgs.join(" ")}\n`);
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

/** Parse `<claude|codex> [--endpoint <url>]` and run. */
export function runInstallCommand(action: "install" | "uninstall", argv: string[]): number {
    const client = argv[0];
    if (!isHookClient(client)) {
        process.stderr.write(`Usage: n2n-nexus ${action} <claude|codex>${action === "install" ? " [--endpoint <url>]" : ""}\n`);
        return 1;
    }
    const i = argv.indexOf("--endpoint");
    const endpoint = action === "install" && i !== -1 ? argv[i + 1] : undefined;
    if (i !== -1 && action === "install" && !endpoint) {
        process.stderr.write("--endpoint needs a URL\n");
        return 1;
    }
    return runInstall({ action, client, endpoint });
}
