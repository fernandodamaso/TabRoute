import { readdirSync, readFileSync, statSync } from "node:fs";
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

const REGISTER_FILES = [
  "background/registerMenus.ts",
  "background/registerCommands.ts"
];

function collectSourceFiles(root: string, relativePath: string): string[] {
  const absolute = join(root, relativePath);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return [];
  }
  if (stats.isFile()) {
    return absolute.endsWith(".ts") || absolute.endsWith(".tsx")
      ? [absolute]
      : [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    files.push(...collectSourceFiles(root, join(relativePath, entry)));
  }
  return files;
}

it("keeps mutating Chrome calls inside the live adapter and Action Engine", async () => {
  const root = join(process.cwd(), "src");
  const forbidden =
    /chrome\.(tabs|tabGroups)\.(group|move|ungroup|remove|update)\s*\(/g;
  for (const file of ["controller/controller.ts", "ui/messages.ts"]) {
    expect(readFileSync(join(root, file), "utf8")).not.toMatch(forbidden);
  }
});

it("keeps feature modules away from repositories and Chrome mutation ports", async () => {
  const root = join(process.cwd(), "src");
  const files = SCAN_PATHS.flatMap((path) => collectSourceFiles(root, path));
  expect(files.length).toBeGreaterThan(0);
  for (const absolute of files) {
    const source = readFileSync(absolute, "utf8");
    expect(source).not.toMatch(/configurationRepository|liveChromePort/);
    expect(source).not.toMatch(
      /chrome\.(tabs|tabGroups)\.(group|move|ungroup|remove|update)\s*\(/
    );
  }
});

it("keeps duplicates pure without Chrome or executeActionPlan imports", () => {
  const root = join(process.cwd(), "src", "duplicates");
  const files = collectSourceFiles(root, ".");
  expect(files.length).toBeGreaterThan(0);
  for (const absolute of files) {
    const source = readFileSync(absolute, "utf8");
    expect(source).not.toMatch(
      /executeActionPlan|liveChromePort|from "\.\.\/chrome\//
    );
    expect(source).not.toMatch(/\bchrome\./);
  }
});

it("keeps menu and command handlers free of Chrome mutations and notifications", () => {
  const root = join(process.cwd(), "src");
  const forbidden =
    /chrome\.(tabs|tabGroups)\.(create|group|move|ungroup|remove|update)\s*\(|chrome\.sessions\.restore|chrome\.notifications/;
  for (const relative of REGISTER_FILES) {
    const source = readFileSync(join(root, relative), "utf8");
    expect(source).not.toMatch(forbidden);
  }
  const background = readFileSync(
    join(process.cwd(), "entrypoints/background.ts"),
    "utf8"
  );
  expect(background).not.toMatch(/chrome\.notifications/);
  expect(background).not.toMatch(/chrome\.tabs\.create\s*\(/);
});
