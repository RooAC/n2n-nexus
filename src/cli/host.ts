/**
 * `n2n-nexus install host [--host <addr>] [--port <port>] [--root <dir>] [--node <path>]`
 * and `n2n-nexus uninstall host`: run the daemon as a service that starts at
 * boot, independent of any IDE. Clients never start a daemon themselves, so
 * this (or running `n2n-nexus daemon` yourself) is how the daemon gets started.
 *
 * Windows only for now: a scheduled task that starts at boot under the current
 * user without a logon ("run whether the user is logged on or not"), hidden and
 * with no time limit. A scheduled task restarts only a program that fails to
 * start, so the task runs the daemon in a loop that starts it again 5 seconds
 * after it exits. Registering it needs an elevated terminal. The daemon's
 * output is appended to `<root>/daemon.log`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { discoveryPort } from "../client/discovery.js";
import { normalizeRootPath } from "../config/paths.js";
import { NEXUS_PORT } from "../constants.js";
import { entryScript } from "./entry.js";
import { InstallError, checkNodePath, stableNodePath } from "./install.js";

export const HOST_TASK_NAME = "n2n-nexus daemon";
const NOT_ELEVATED_EXIT = 3;
const HOST_PATTERN = /^[A-Za-z0-9.:-]+$/;

export type HostOptions = { host: string; port: number; root: string; node: string; entry: string };
/** Runs a PowerShell script; returns its exit status and combined output. */
export type ScriptRunner = (script: string) => { status: number | null; output: string };

/** A PowerShell single-quoted string literal. */
const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The daemon's arguments as the task writes them, also used to recognise its process. */
export const daemonArgs = (o: HostOptions) => `daemon --host ${o.host} --port ${o.port} --root "${o.root}"`;

/**
 * Script preamble: text output in UTF-8, no progress records, every error as
 * one line of text, and exit NOT_ELEVATED_EXIT without administrator rights.
 */
const PREAMBLE = `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
trap { Write-Output "ERROR: $($_.Exception.Message)"; exit 1 }
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit ${NOT_ELEVATED_EXIT} }`;

/** Stop the task if it is registered, and end the daemons started from `entry` (quoted or not). */
const stopDaemons = (entry: string) => `if (Get-ScheduledTask -TaskName ${ps(HOST_TASK_NAME)} -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName ${ps(HOST_TASK_NAME)} }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and ($_.CommandLine.Contains(${ps(`"${entry}" daemon `)}) -or $_.CommandLine.Contains(${ps(`${entry} daemon `)}))
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue      # it may have ended with the task
    Write-Output "Stopped daemon PID $($_.ProcessId)."
}`;

/** PowerShell that (re)registers and starts the task, then reports who listens on the port. */
export function hostInstallScript(o: HostOptions): string {
    const log = path.win32.join(o.root, "daemon.log");
    // cmd's for /l loop runs the daemon again after it exits; ping is the delay that works without a console.
    const command = `/c for /l %i in (0,0,1) do ("${o.node}" "${o.entry}" ${daemonArgs(o)} >> "${log}" 2>&1 & ping -n 6 127.0.0.1 >nul)`;
    return `${PREAMBLE}
${stopDaemons(o.entry)}
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ${ps(command)} -WorkingDirectory ${ps(o.root)}
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName ${ps(HOST_TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ${ps(`n2n-nexus daemon on ${o.host}:${o.port}`)} -Force | Out-Null
Write-Output ${ps(`Registered scheduled task "${HOST_TASK_NAME}" (starts at boot).`)}
Start-ScheduledTask -TaskName ${ps(HOST_TASK_NAME)}
Start-Sleep -Seconds 3
$listener = Get-NetTCPConnection -LocalPort ${o.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) { Write-Output ${ps(`Nothing listens on port ${o.port} yet; see ${log}.`)}; exit 0 }
$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if ($owner.CommandLine -and $owner.CommandLine.Contains(${ps(daemonArgs(o))})) { Write-Output "Daemon running (PID $($listener.OwningProcess))." }
else { Write-Output "Port ${o.port} is used by PID $($listener.OwningProcess): $($owner.CommandLine). Stop it; the task starts the daemon again within 5 seconds." }
`;
}

/** PowerShell that stops and removes the task and ends the daemons started from this entry script. */
export function hostUninstallScript(entry: string): string {
    return `${PREAMBLE}
${stopDaemons(entry)}
if (Get-ScheduledTask -TaskName ${ps(HOST_TASK_NAME)} -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName ${ps(HOST_TASK_NAME)} -Confirm:$false
    Write-Output ${ps(`Removed scheduled task "${HOST_TASK_NAME}".`)}
} else {
    Write-Output ${ps(`Scheduled task "${HOST_TASK_NAME}" is not installed.`)}
}
`;
}

/** Runs a script with Windows PowerShell (NEXUS_POWERSHELL overrides the executable). */
const runPowerShell: ScriptRunner = (script) => {
    const result = spawnSync(process.env.NEXUS_POWERSHELL || "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { encoding: "utf8", windowsHide: true });
    return { status: result.error ? null : result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}` };
};

const HOST_FLAGS = ["--host", "--port", "--root", "--node"];

function parseHostArgs(argv: string[]): Omit<HostOptions, "entry"> {
    for (let i = 0; i < argv.length; i += 2) {
        if (!HOST_FLAGS.includes(argv[i])) throw new InstallError(`unknown option ${argv[i]} (expected ${HOST_FLAGS.join(", ")})`);
    }
    const value = (name: string, what: string): string | undefined => {
        const i = argv.indexOf(name);
        if (i === -1) return undefined;
        const v = argv[i + 1];
        if (!v || v.startsWith("--")) throw new InstallError(`${name} needs ${what}`);
        return v;
    };
    const host = value("--host", "an address") ?? "127.0.0.1";
    if (!HOST_PATTERN.test(host)) throw new InstallError(`--host ${host}: not an address`);
    const portText = value("--port", "a port number");
    const port = portText === undefined ? NEXUS_PORT : Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InstallError(`--port ${portText}: not a port number`);
    let root = normalizeRootPath(value("--root", "a directory"));
    // cmd expands %VAR% even inside quotes, and a trailing backslash would escape the closing quote.
    if (root.includes("%") || root.includes('"')) throw new InstallError(`--root ${root}: % and " are not supported in the path`);
    if (root.endsWith("\\")) root += ".";
    const nodeArg = value("--node", "a path");
    const node = nodeArg ? checkNodePath(nodeArg) : stableNodePath();
    if (node.includes("%") || node.includes('"')) throw new InstallError(`node path ${node}: % and " are not supported`);
    return { host, port, root, node };
}

/** `install host` / `uninstall host`; prints what happened and returns the exit code. */
export function runHostCommand(action: "install" | "uninstall", argv: string[], run: ScriptRunner = runPowerShell, platform: NodeJS.Platform = process.platform): number {
    try {
        if (platform !== "win32") {
            throw new InstallError(`${action} host supports Windows only for now. Run "n2n-nexus daemon --host <address>" as a systemd service or launchd agent instead.`);
        }
        const entry = entryScript();
        if (entry.includes("%") || entry.includes('"')) throw new InstallError(`entry script ${entry}: % and " are not supported in the path`);
        let script: string;
        let note = "";
        if (action === "install") {
            const options = { ...parseHostArgs(argv), entry };
            // mkdir of an existing drive root fails with EPERM on Windows, even with recursive.
            if (!fs.existsSync(options.root)) fs.mkdirSync(options.root, { recursive: true });
            script = hostInstallScript(options);
            if (options.host !== "127.0.0.1" && options.host !== "localhost") {
                note = `Other machines reach it only if Windows Firewall allows TCP ${options.port} and UDP ${discoveryPort()} (discovery) from them.\n`;
            }
        } else {
            if (argv.length > 0) throw new InstallError(`unknown option ${argv[0]}`);
            script = hostUninstallScript(entry);
        }
        const { status, output } = run(script);
        if (status === NOT_ELEVATED_EXIT) {
            throw new InstallError(`${action} host needs an elevated terminal: open PowerShell with "Run as administrator" and run it again.`);
        }
        if (status !== 0) throw new InstallError(output.trim() || `PowerShell exited with ${status}`);
        process.stdout.write(output.trimEnd() + "\n" + note);
        return 0;
    } catch (error) {
        process.stderr.write(`[n2n-nexus] ${action} host failed: ${(error as Error).message}\n`);
        return 1;
    }
}
