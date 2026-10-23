import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { HOST_TASK_NAME, hostInstallScript, hostUninstallScript, runHostCommand, type ScriptRunner } from "../src/cli/host.js";

const ROOT = path.join(process.cwd(), "tests", "tmp", "host-install", "root");
let stdout = "";
let stderr = "";
let scripts: string[] = [];

/**
 * Whether the script's stop filter matches a node.exe command line, evaluated as PowerShell does:
 * `.Contains('…')` is ordinal and case-sensitive, `-match '…'` a case-insensitive regex.
 */
function stopsProcess(script: string, commandLine: string): boolean {
    const filter = /Where-Object \{([\s\S]*?)\n\}/.exec(script)![1];
    const literal = (text: string) => text.replace(/''/g, "'");
    const contains = [...filter.matchAll(/\.Contains\('((?:[^']|'')*)'\)/g)].map((m) => literal(m[1]));
    const patterns = [...filter.matchAll(/-match '((?:[^']|'')*)'/g)].map((m) => new RegExp(literal(m[1]), "i"));
    return contains.some((text) => commandLine.includes(text)) || patterns.some((pattern) => pattern.test(commandLine));
}

/** A runner that records each script and answers with `status` and `output`. */
const runner = (status: number | null, output = ""): ScriptRunner => (script) => {
    scripts.push(script);
    return { status, output };
};

beforeEach(() => {
    stdout = ""; stderr = ""; scripts = [];
    for (const name of Object.keys(process.env)) if (name.startsWith("NEXUS_")) vi.stubEnv(name, undefined);
    fs.rmSync(path.dirname(ROOT), { recursive: true, force: true });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe("host scripts", () => {
    const options = { host: "0.0.0.0", port: 5799, root: String.raw`C:\Users\O'Brien\.n2n-nexus`, node: String.raw`C:\node\node.exe`, entry: String.raw`C:\nexus\build\index.js` };

    it("registers a boot task that runs the daemon without a logon or a time limit, in a loop that restarts it", () => {
        const script = hostInstallScript(options);
        expect(script).toContain("New-ScheduledTaskTrigger -AtStartup");
        expect(script).toContain("-LogonType S4U");
        expect(script).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
        expect(script).toContain(`Register-ScheduledTask -TaskName '${HOST_TASK_NAME}'`);
        expect(script).toContain(`Start-ScheduledTask -TaskName '${HOST_TASK_NAME}'`);
        // The single quote in the path is doubled inside PowerShell single-quoted strings.
        expect(script).toContain(String.raw`-Argument '/c for /l %i in (0,0,1) do ("C:\node\node.exe" "C:\nexus\build\index.js" daemon --host 0.0.0.0 --port 5799 --root "C:\Users\O''Brien\.n2n-nexus" >> "C:\Users\O''Brien\.n2n-nexus\daemon.log" 2>&1 & ping -n 6 127.0.0.1 >nul)'`);
        // A reinstall first stops the running task and daemon, so new options take effect.
        expect(script.indexOf("Stop-ScheduledTask")).toBeLessThan(script.indexOf("Register-ScheduledTask"));
        expect(script.indexOf("Stop-Process")).toBeLessThan(script.indexOf("Register-ScheduledTask"));
        // Its own daemon is recognised by host, port and root together.
        expect(script).toContain(String.raw`.Contains('daemon --host 0.0.0.0 --port 5799 --root "C:\Users\O''Brien\.n2n-nexus"')`);
        expect(script).toContain(`$ProgressPreference = "SilentlyContinue"`);
        expect(script).toContain("exit 3");                                            // not elevated
    });

    it("removes the task and stops only the daemons started from the entry script", () => {
        const script = hostUninstallScript(options.entry);
        expect(script).toContain(`Stop-ScheduledTask -TaskName '${HOST_TASK_NAME}'`);
        expect(script).toContain(`Unregister-ScheduledTask -TaskName '${HOST_TASK_NAME}' -Confirm:$false`);
        expect(stopsProcess(script, String.raw`"C:\node\node.exe" "C:\nexus\build\index.js" daemon --port 5688`)).toBe(true);
        expect(stopsProcess(script, String.raw`node C:\nexus\build\index.js daemon --port 5688`)).toBe(true);
        expect(script).not.toContain("-like");
    });

    it("stops daemons started through the npm shims, and no other node process", () => {
        const entry = String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\n2n-nexus\build\index.js`;
        const script = hostUninstallScript(entry);
        const node = String.raw`"C:\Program Files\nodejs\node.exe"`;
        // n2n-nexus.cmd: %dp0% ends with a backslash and the shim adds another one.
        expect(stopsProcess(script, String.raw`${node}  "C:\Users\u\AppData\Roaming\npm\\node_modules\n2n-nexus\build\index.js" daemon --port 5688`)).toBe(true);
        // n2n-nexus.ps1: "$basedir/node_modules/..." with forward slashes, and no further arguments.
        expect(stopsProcess(script, String.raw`${node} "C:\Users\u\AppData\Roaming\npm/node_modules/n2n-nexus/build/index.js" daemon`)).toBe(true);
        expect(stopsProcess(script, String.raw`node c:\users\U\AppData\Roaming\npm\node_modules\n2n-nexus\build\index.js daemon --host 0.0.0.0`)).toBe(true);
        for (const other of [
            `${node} "${entry}" mcp`,
            `${node} "${entry}" hook claude`,
            `${node} "${entry}" daemonize`,
            `${node} "${entry}.bak" daemon`,
            String.raw`${node} "C:\other\build\index.js" daemon`,
            String.raw`${node} "D:\x${entry.slice(2)}" daemon`
        ]) expect(stopsProcess(script, other), other).toBe(false);
    });

    it("waits for a running task instance to end before starting the task again", () => {
        const script = hostInstallScript(options);
        const beforeStart = script.slice(script.indexOf("Register-ScheduledTask"), script.indexOf("Start-ScheduledTask"));
        // -MultipleInstances IgnoreNew drops a start while the stopped instance is still running.
        expect(beforeStart).toMatch(/for \(\$i = 0; \$i -lt \d+ -and \(Get-ScheduledTask -TaskName 'n2n-nexus daemon'\)\.State -eq "Running"; \$i\+\+\) \{ Start-Sleep -Milliseconds \d+ \}/);
    });

    it("quotes paths with spaces, &, parentheses, quotes and non-ASCII letters", () => {
        const dir = String.raw`C:\Users\Zoë O'Brien (work) & co`;
        const odd = { host: "127.0.0.1", port: 5688, root: String.raw`${dir}\.n2n-nexus`, node: String.raw`C:\Program Files (x86)\nodejs\node.exe`, entry: String.raw`${dir}\npm\node_modules\n2n-nexus\build\index.js` };
        const script = hostInstallScript(odd);
        const q = (text: string) => text.replace(/'/g, "''");
        expect(script).toContain(String.raw`-Argument '/c for /l %i in (0,0,1) do ("${odd.node}" "${q(odd.entry)}" daemon --host 127.0.0.1 --port 5688 --root "${q(odd.root)}" >> "${q(odd.root)}\daemon.log" 2>&1 & ping -n 6 127.0.0.1 >nul)'`);
        expect(script).toContain(`-WorkingDirectory '${q(odd.root)}'`);
        expect(stopsProcess(script, `"${odd.node}" "${odd.entry}" daemon --host 127.0.0.1 --port 5688 --root "${odd.root}"`)).toBe(true);
        expect(stopsProcess(script, String.raw`"${odd.node}" "${dir}\npm\other\index.js" daemon`)).toBe(false);
    });
});

describe("runHostCommand", () => {
    it("install: runs the script with the options, creates the root and prints what it did", () => {
        const code = runHostCommand("install", ["--host", "0.0.0.0", "--port", "5799", "--root", ROOT], runner(0, "Registered.\nDaemon running (PID 7).\n"), "win32");
        expect(code).toBe(0);
        expect(fs.existsSync(ROOT)).toBe(true);
        expect(scripts).toHaveLength(1);
        expect(scripts[0]).toContain(`daemon --host 0.0.0.0 --port 5799 --root "${ROOT}"`);
        expect(stdout).toContain("Daemon running (PID 7).");
        // The service daemon reads the discovery port from the user's or the machine's environment, so the script reports it.
        expect(scripts[0]).toContain(`[Environment]::GetEnvironmentVariable("NEXUS_DISCOVERY_PORT", "User")`);
        expect(scripts[0]).toContain("Windows Firewall allows TCP 5799 and UDP $discovery (discovery)");
        expect(stderr).toBe("");
    });

    it("install: does not report this shell's NEXUS_* variables as the service daemon's", () => {
        vi.stubEnv("NEXUS_DISCOVERY_PORT", "6000");
        vi.stubEnv("NEXUS_RATE_LIMIT", "5");
        expect(runHostCommand("install", ["--host", "0.0.0.0", "--root", ROOT], runner(0, "ok"), "win32")).toBe(0);
        expect(stdout).not.toContain("UDP 6000");
        expect(stdout).toContain("NEXUS_DISCOVERY_PORT, NEXUS_RATE_LIMIT are set in this shell, but the service daemon does not get this shell's environment");
    });

    it("install: puts NEXUS_ROOT and --node into the task command", () => {
        vi.stubEnv("NEXUS_ROOT", ROOT);
        expect(runHostCommand("install", ["--node", process.execPath], runner(0, "ok"), "win32")).toBe(0);
        expect(scripts[0]).toContain(`("${process.execPath}" "`);
        expect(scripts[0]).toContain(`daemon --host 127.0.0.1 --port 5688 --root "${ROOT}"`);
        expect(stdout).not.toContain("NEXUS_ROOT");               // it reaches the daemon as --root
    });

    it("install: defaults to 127.0.0.1:5688 and says nothing about the firewall", () => {
        expect(runHostCommand("install", ["--root", ROOT], runner(0, "ok"), "win32")).toBe(0);
        expect(scripts[0]).toContain("daemon --host 127.0.0.1 --port 5688");
        expect(stdout).not.toContain("Firewall");
    });

    it("asks for an elevated terminal when the script is not run as administrator", () => {
        expect(runHostCommand("install", ["--root", ROOT], runner(3), "win32")).toBe(1);
        expect(stderr).toContain("Run as administrator");
        expect(runHostCommand("uninstall", [], runner(3), "win32")).toBe(1);
    });

    it("reports a failing script with its output", () => {
        expect(runHostCommand("install", ["--root", ROOT], runner(1, "ERROR: Access is denied."), "win32")).toBe(1);
        expect(stderr).toContain("Access is denied.");
        expect(runHostCommand("install", ["--root", ROOT], runner(null, "spawn powershell.exe ENOENT"), "win32")).toBe(1);
        expect(stderr).toContain("ENOENT");
    });

    // Drive paths only mean something on Windows (elsewhere normalizeRootPath maps them to /mnt/<drive>).
    it.runIf(process.platform === "win32")("handles a drive root and rejects paths cmd would change", () => {
        expect(runHostCommand("install", ["--root", "D:\\"], runner(0, "ok"), "win32")).toBe(0);
        expect(scripts[0]).toContain(String.raw`--root "D:\."`);
        expect(runHostCommand("install", ["--root", String.raw`C:\data%TEMP%`], runner(0), "win32")).toBe(1);
        expect(scripts).toHaveLength(1);
    });

    it("rejects bad options without running anything", () => {
        expect(runHostCommand("install", ["--port", "abc"], runner(0), "win32")).toBe(1);
        expect(runHostCommand("install", ["--port", "70000"], runner(0), "win32")).toBe(1);
        expect(runHostCommand("install", ["--host", "a b"], runner(0), "win32")).toBe(1);
        expect(runHostCommand("install", ["--host", "1.2.3.4&calc"], runner(0), "win32")).toBe(1);
        expect(runHostCommand("install", ["--prot", "5799"], runner(0), "win32")).toBe(1);
        expect(stderr).toContain("unknown option --prot");
        expect(runHostCommand("install", ["--host"], runner(0), "win32")).toBe(1);
        expect(stderr).toContain("--host needs an address");
        expect(stderr).toContain("--port 70000: not a port number");
        expect(stderr).toContain("--host a b: not an address");
        expect(runHostCommand("install", ["--root"], runner(0), "win32")).toBe(1);
        expect(stderr).toContain("--root needs a directory");
        expect(runHostCommand("install", ["--node"], runner(0), "win32")).toBe(1);
        expect(stderr).toContain("--node needs a path");
        expect(runHostCommand("install", ["--node", path.join(ROOT, "missing-node")], runner(0), "win32")).toBe(1);
        expect(stderr).toContain("not an executable file");
        expect(runHostCommand("uninstall", ["--force"], runner(0), "win32")).toBe(1);
        expect(scripts).toEqual([]);
    });

    it("reports a flag without its value as such, and rejects a repeated flag", () => {
        expect(runHostCommand("install", ["--host", "--port", "5799"], runner(0), "win32")).toBe(1);
        expect(stderr).toContain("--host needs an address");
        expect(stderr).not.toContain("unknown option");
        stderr = "";
        expect(runHostCommand("install", ["--port", "5799", "--port", "5800"], runner(0), "win32")).toBe(1);
        expect(stderr).toContain("--port is given more than once");
        expect(scripts).toEqual([]);
    });

    it("uninstall: runs the removal script", () => {
        expect(runHostCommand("uninstall", [], runner(0, "Removed scheduled task."), "win32")).toBe(0);
        expect(scripts[0]).toContain("Unregister-ScheduledTask");
        expect(stdout).toContain("Removed scheduled task.");
    });

    it("says what to do instead on other platforms", () => {
        expect(runHostCommand("install", [], runner(0), "linux")).toBe(1);
        expect(scripts).toEqual([]);
        expect(stderr).toContain("Windows only");
        expect(stderr).toContain("systemd");
    });
});
