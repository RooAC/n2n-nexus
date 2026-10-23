import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { HOST_TASK_NAME, hostInstallScript, hostUninstallScript, runHostCommand, type ScriptRunner } from "../src/cli/host.js";

const ROOT = path.join(process.cwd(), "tests", "tmp", "host-install", "root");
let stdout = "";
let stderr = "";
let scripts: string[] = [];
const savedDiscoveryPort = process.env.NEXUS_DISCOVERY_PORT;

/** A runner that records each script and answers with `status` and `output`. */
const runner = (status: number | null, output = ""): ScriptRunner => (script) => {
    scripts.push(script);
    return { status, output };
};

beforeEach(() => {
    stdout = ""; stderr = ""; scripts = [];
    delete process.env.NEXUS_DISCOVERY_PORT;
    fs.rmSync(path.dirname(ROOT), { recursive: true, force: true });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
});

afterEach(() => {
    vi.restoreAllMocks();
    if (savedDiscoveryPort === undefined) delete process.env.NEXUS_DISCOVERY_PORT;
    else process.env.NEXUS_DISCOVERY_PORT = savedDiscoveryPort;
});

describe("host scripts", () => {
    const options = { host: "0.0.0.0", port: 5799, root: String.raw`C:\Users\O'Brien\.n2n-nexus`, node: String.raw`C:\node\node.exe`, entry: String.raw`C:\nexus\build\index.js` };

    it("registers a boot task that runs the daemon hidden, without a time limit, in a loop that restarts it", () => {
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
        expect(script).toContain(String.raw`.Contains('"C:\nexus\build\index.js" daemon ')`);
        expect(script).toContain(String.raw`.Contains('C:\nexus\build\index.js daemon ')`);
        expect(script).not.toContain("-like");
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
        expect(stdout).toContain("Windows Firewall allows TCP 5799 and UDP 5688 (discovery)");
        expect(stderr).toBe("");
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
        expect(runHostCommand("uninstall", ["--force"], runner(0), "win32")).toBe(1);
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
