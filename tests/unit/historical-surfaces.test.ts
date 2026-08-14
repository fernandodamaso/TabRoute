import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = [
  "Quick Actions",
  "Templates",
  "Suggestions",
  "42:5",
  "42:7",
  "42:9",
  "42:10",
  "36:2"
] as const;

const ROOTS = [
  "src",
  "docs/release-checklist.md",
  "tests/e2e/canonical-frames"
] as const;

async function collectFiles(target: string): Promise<string[]> {
  const absolute = path.resolve(target);
  try {
    const stats = await import("node:fs/promises").then((fs) =>
      fs.stat(absolute)
    );
    if (stats.isFile()) return [absolute];
  } catch {
    return [];
  }
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await visit(next);
        continue;
      }
      if (/\.(ts|tsx|md|json|css|html)$/i.test(entry.name)) files.push(next);
    }
  }
  await visit(absolute);
  return files;
}

describe("historical surfaces stay out of release evidence", () => {
  it("does not cite deleted Figma nodes or removed product surfaces", async () => {
    const files = (
      await Promise.all(ROOTS.map((root) => collectFiles(root)))
    ).flat();
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const needle of FORBIDDEN) {
        if (text.includes(needle))
          hits.push(`${path.relative(process.cwd(), file)}: ${needle}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
