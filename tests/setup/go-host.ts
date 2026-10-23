// Vitest globalSetup of the client tests: build the n2n-nexus-host test binary
// (go build -tags testclock) once. Tests that need a real host start it with
// Host from tests/conformance/harness.ts, which runs NEXUS_HOST_BIN (set to
// GO_HOST_BIN in vitest.config.ts).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

export const GO_HOST_BIN = path.join(REPO, "host", "bin", "test", `n2n-nexus-host${process.platform === "win32" ? ".exe" : ""}`);

export default function setup(): void {
    execFileSync("go", ["build", "-tags", "testclock", "-o", GO_HOST_BIN, "./host/cmd/n2n-nexus-host"], { cwd: REPO, stdio: "inherit" });
}
