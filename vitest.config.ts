import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        exclude: [...configDefaults.exclude, "tests/conformance/**"],  // run by vitest.conformance.config.ts
        fileParallelism: false,  // Run test files sequentially to avoid directory conflicts
    },
});
