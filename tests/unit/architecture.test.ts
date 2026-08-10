import { readFile } from "node:fs/promises";
import { join } from "node:path";

it("keeps mutating Chrome calls inside the live adapter and Action Engine", async () => {
  const root = join(process.cwd(), "src");
  const forbidden = /chrome\.(tabs|tabGroups)\.(group|move|ungroup|remove|update)\s*\(/g;
  for (const file of ["controller/controller.ts", "ui/messages.ts"]) {
    expect(await readFile(join(root, file), "utf8")).not.toMatch(forbidden);
  }
});

it("keeps manager UI modules away from repositories and Chrome mutation ports", async () => {
  const root = join(process.cwd(), "src", "ui");
  const files = [
    "messages.ts",
    "manager/types.ts"
  ];
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    expect(source).not.toMatch(/configurationRepository|liveChromePort|chrome\.(tabs|tabGroups)/);
  }
});
