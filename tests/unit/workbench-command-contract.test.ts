import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const expected = {
  "build:workbench": "tsx scripts/workbench/cli.ts build-workbench",
  workbench: "tsx scripts/workbench/cli.ts workbench --mode fixture",
  "workbench:real": "tsx scripts/workbench/cli.ts workbench --mode real",
  "test:workbench": "tsx scripts/workbench/cli.ts test-workbench",
  "test:extension": "tsx scripts/workbench/cli.ts test-extension",
  "smoke:popup": "tsx scripts/workbench/cli.ts smoke-popup"
} as const;

describe("package workbench command contracts", () => {
  it("publishes the six approved package scripts exactly", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(expected))
      expect(pkg.scripts[name]).toBe(command);
  });

  it.each(Object.keys(expected))("dispatches npm run %s through the CLI in contract mode", async (name) => {
    const executable = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", `npm run ${name} -- --contract`]
      : ["run", name, "--", "--contract"];
    const { stdout } = await execute(executable, args, {
      cwd: process.cwd(),
      windowsHide: true
    });
    expect(stdout).toContain('"action"');
  });
});
