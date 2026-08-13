import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SCAN_PATHS = [
  "controller/controller.ts",
  "ui/messages.ts",
  "duplicates",
  "activity",
  "persistence",
  "snapshots",
  "background"
];

it("keeps mutating Chrome calls inside the live adapter and Action Engine", async () => {
  const root = join(process.cwd(), "src");
  const forbidden = /chrome\.(tabs|tabGroups)\.(group|move|ungroup|remove|update)\s*\(/g;
  for (const file of ["controller/controller.ts", "ui/messages.ts"]) {
    expect(await readFile(join(root, file), "utf8")).not.toMatch(forbidden);
  }
});

it("keeps feature modules away from repositories and Chrome mutation ports", async () => {
  const root = join(process.cwd(), "src");
  for (const file of SCAN_PATHS) {
    const absolute = join(root, file);
    let source: string;
    try {
      source = await readFile(absolute, "utf8");
    } catch {
      continue;
    }
    expect(source).not.toMatch(/configurationRepository|liveChromePort/);
    expect(source).not.toMatch(/chrome\.(tabs|tabGroups)\.(group|move|ungroup|remove|update)\s*\(/);
  }
});
