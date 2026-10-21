#!/usr/bin/env node
import { pkg } from "./config/index.js";

const command = process.argv[2] || "mcp";

if (command === "--version" || command === "-v") {
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
}

if (command === "--help" || command === "-h") {
    process.stdout.write(`
n2n-nexus v${pkg.version} — Multi-AI assistant coordination hub

USAGE:
  n2n-nexus daemon   Start the Nexus server (run once, stays alive)
  n2n-nexus mcp      Start the MCP proxy (launched by IDE automatically)
  n2n-nexus install <claude|codex> [--endpoint <url>] [--node <path>]
                     Register the hooks and the MCP server with Claude Code or Codex
  n2n-nexus uninstall <claude|codex>
                     Remove the hooks and the MCP server installed by install
  n2n-nexus doctor [claude|codex]
                     Check that the Node path and entry script in the installed hook and
                     MCP commands exist and run; exit 1 and say how to fix them when not
  n2n-nexus hook <claude|codex> [--endpoint <url>]
                     Forward a client hook event to the daemon (run by the hooks)

OPTIONS:
  --root <path>      Storage directory for daemon (default: ~/.n2n-nexus)
  --port <port>      HTTP port for daemon (default: 5688)
  --host <host>      Host address for daemon (default: 127.0.0.1)
  --id <id>          Instance ID for MCP proxy (default: mcp-<hostname>-<cwd hash>-<IDE name>)
  --endpoint <url>   Daemon URL for hook (default: NEXUS_ENDPOINT, then http://127.0.0.1:5688);
                     install writes it into the hook and MCP commands
  --node <path>      Node executable written into the hook and MCP commands by install
                     (default: the node on PATH when it is the running one, else its real path)
  --version, -v      Show version
  --help, -h         Show this help

ENVIRONMENT:
  NEXUS_ROOT         Override --root
  NEXUS_DAEMON_PORT  Override --port
  NEXUS_HOST         Override --host
  NEXUS_ENDPOINT     Daemon URL for MCP proxy and hook (default: http://127.0.0.1:5688)
  NEXUS_INSTANCE_ID  Override --id for MCP proxy
`);
    process.exit(0);
}

async function main() {
    if (command === "hook") {
        const { runHook } = await import("./cli/hook.js");
        process.exit(await runHook(process.argv.slice(3)));
    }

    if (command === "install" || command === "uninstall") {
        const { runInstallCommand } = await import("./cli/install.js");
        process.exit(runInstallCommand(command, process.argv.slice(3)));
    }

    if (command === "doctor") {
        const { runDoctor } = await import("./cli/doctor.js");
        process.exit(runDoctor(process.argv.slice(3)));
    }

    if (command === "daemon") {
        const { runDaemon } = await import("./daemon/index.js");
        await runDaemon();
        return;
    }

    // Default: mcp
    const { NexusServer } = await import("./server/nexus.js");
    const server = new NexusServer();
    await server.run();
}

main().catch(err => {
    console.error("[n2n-nexus] Fatal error:", err);
    process.exit(1);
});
