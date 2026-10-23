import { defineConfig } from "vitest/config";

// Black-box conformance tests against the host executable in NEXUS_HOST_BIN
// (NEXUS_HOST_KIND = "go" or "ts"); see tests/conformance/harness.ts.
export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/conformance/**/*.test.ts"],
        fileParallelism: false,  // one host process at a time
        testTimeout: 30_000,
    },
});
