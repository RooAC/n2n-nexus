import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, "../../package.json");
export const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name: string; version: string };
