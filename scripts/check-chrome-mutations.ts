import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");
const SCAN_DIRS = [
  "ui",
  "duplicates",
  "activity",
  "persistence",
  "snapshots",
  "background"
];

const FORBIDDEN_PATTERNS = [
  /\bchrome\.tabs\.remove\s*\(/,
  /\bchrome\.tabs\.update\s*\(/,
  /\bchrome\.tabs\.create\s*\(/,
  /\bchrome\.tabs\.group\s*\(/,
  /\bchrome\.tabs\.move\s*\(/,
  /\bchrome\.tabs\.ungroup\s*\(/,
  /\bchrome\.tabGroups\.update\s*\(/,
  /\bchrome\.tabGroups\.move\s*\(/,
  /\bbrowser\.tabs\.remove\s*\(/,
  /\bdeps\.mutations\.removeTabs\s*\(/
];

export function scanChromeMutations(root = ROOT): string[] {
  const violations: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!absolute.endsWith(".ts") && !absolute.endsWith(".tsx")) continue;
      const relativePath = relative(root, absolute).replaceAll("\\", "/");
      if (relativePath.includes("liveChromePort")) continue;
      const source = readFileSync(absolute, "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${relativePath}: ${pattern}`);
        }
      }
    }
  }
  for (const dir of SCAN_DIRS) {
    const absolute = join(root, dir);
    try {
      visit(absolute);
    } catch {
      // optional directories may not exist yet
    }
  }
  const controllerPath = join(root, "controller", "controller.ts");
  const controllerSource = readFileSync(controllerPath, "utf8");
  if (/\bdeps\.mutations\./.test(controllerSource)) {
    violations.push("controller/controller.ts: deps.mutations");
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  const violations = scanChromeMutations();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
}
