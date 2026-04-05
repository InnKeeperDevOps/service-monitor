import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, "../../web/dist");
const dest = resolve(__dirname, "../dist/public");

if (!existsSync(src)) {
  console.error("[copy-web] Warning: apps/web/dist not found — skipping static copy");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.error("[copy-web] Copied web dist → api/dist/public");
