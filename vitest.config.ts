import { configDefaults, defineConfig } from "vitest/config";

import { GO_HOST_BIN } from "./tests/setup/go-host.js";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        exclude: [...configDefaults.exclude, "tests/conformance/**"],  // run by vitest.conformance.config.ts
        fileParallelism: false,  // Run test files sequentially to avoid directory conflicts
        globalSetup: ["tests/setup/go-host.ts"],
        env: { NEXUS_HOST_BIN: GO_HOST_BIN },
    },
});
