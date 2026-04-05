import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STABLE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseStableSemverTag(tag) {
  const match = STABLE_TAG_PATTERN.exec(tag.trim());
  if (!match) {
    return null;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function compareSemver(a, b) {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (aParts[i] > bParts[i]) {
      return 1;
    }
    if (aParts[i] < bParts[i]) {
      return -1;
    }
  }
  return 0;
}

export function selectLatestVersionFromTags(tags) {
  let latest = null;
  for (const tag of tags) {
    const version = parseStableSemverTag(tag);
    if (!version) {
      continue;
    }
    if (latest === null || compareSemver(version, latest) > 0) {
      latest = version;
    }
  }
  return latest;
}

export function bumpVersion(version, level) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (level === "major") {
    return `${major + 1}.0.0`;
  }
  if (level === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  if (level === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }
  throw new Error(`Unsupported bump level: ${level}`);
}

function parseCliArgs(argv) {
  let level = "patch";
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--level") {
      level = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, level, dryRun };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help: false, level, dryRun };
}

function getRepoTags() {
  const output = execSync("git tag --list", { encoding: "utf8" });
  return output
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function findPackageJsonFiles(rootDir) {
  const files = [];
  const ignore = new Set([".git", "node_modules", ".turbo", ".next", "dist", "build"]);

  function walk(currentDir) {
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      if (ignore.has(entry)) {
        continue;
      }
      const fullPath = path.join(currentDir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry === "package.json") {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function updatePackageVersion(packageJsonPath, nextVersion, dryRun) {
  const raw = readFileSync(packageJsonPath, "utf8");
  const data = JSON.parse(raw);
  if (typeof data.version !== "string") {
    return false;
  }
  if (data.version === nextVersion) {
    return false;
  }
  data.version = nextVersion;
  if (!dryRun) {
    writeFileSync(packageJsonPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
  return true;
}

export function runBumpVersionFromTags(cwd, options) {
  const { level, dryRun } = options;
  const tags = getRepoTags();
  const latest = selectLatestVersionFromTags(tags);
  if (!latest) {
    throw new Error('No stable semver tags found. Expected tags like "v1.2.3".');
  }

  const nextVersion = bumpVersion(latest, level);
  const packageJsonFiles = findPackageJsonFiles(cwd);

  const updated = [];
  for (const packageJsonPath of packageJsonFiles) {
    if (updatePackageVersion(packageJsonPath, nextVersion, dryRun)) {
      updated.push(path.relative(cwd, packageJsonPath));
    }
  }

  return { latest, nextVersion, updated };
}

function printHelp() {
  console.log("Usage: node scripts/bump-version-from-tags.mjs [--level patch|minor|major] [--dry-run]");
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const result = runBumpVersionFromTags(process.cwd(), args);
  console.log(`Latest tag version: ${result.latest}`);
  console.log(`Next version: ${result.nextVersion}`);
  if (result.updated.length === 0) {
    console.log("No package.json files were updated.");
    return;
  }
  console.log("Updated package.json files:");
  for (const file of result.updated) {
    console.log(`- ${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
