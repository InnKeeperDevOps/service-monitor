import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(apiRoot, "..", "..");
const sourceDir = path.resolve(workspaceRoot, "apps/web/dist");
const targetDir = path.resolve(apiRoot, "dist/public");

if (!fs.existsSync(sourceDir)) {
  console.warn(`[api] web dist not found at ${sourceDir}; skipping copy`);
  process.exit(0);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });
console.log(`[api] copied web dist -> ${targetDir}`);
