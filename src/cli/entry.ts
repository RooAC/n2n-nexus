import { fileURLToPath } from "node:url";

/** Absolute path of the package entry script (`build/index.js` next to `build/cli/`). */
export function entryScript(): string {
    return fileURLToPath(new URL("../index.js", import.meta.url));
}
