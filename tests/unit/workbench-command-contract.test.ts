import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const adoptionDocPath = path.join("docs", "agent-development-workbench.md");
const expected = {
  "build:workbench": "tsx scripts/workbench/cli.ts build-workbench",
  workbench: "tsx scripts/workbench/cli.ts workbench --mode fixture",
  "workbench:real": "tsx scripts/workbench/cli.ts workbench --mode real",
  "test:workbench": "tsx scripts/workbench/cli.ts test-workbench",
  "test:extension": "tsx scripts/workbench/cli.ts test-extension",
  "smoke:popup": "tsx scripts/workbench/cli.ts smoke-popup"
} as const;

const adoptionRequirements = [
  "build:workbench",
  "workbench:real",
  "test:workbench",
  "test:extension",
  "smoke:popup",
  "ManagerApp",
  "ManagerTransport",
  "WORKBENCH_ARGUMENT",
  "WORKBENCH_WORKER_TIMEOUT",
  "WORKBENCH_MANAGER_TIMEOUT",
  "WORKBENCH_CLEANUP_FAILED",
  "WORKBENCH_CAPACITY",
  "WORKBENCH_ARTIFACT_LIMIT",
  "520×600",
  "wb:offline",
  "Removal path",
  "Non-goals",
  "Future UI issue checklist",
  "Feature-storage ownership",
  "Never attach to the user's Chrome",
  "Branded Chrome release",
  "FDM-619"
] as const;

describe("package workbench command contracts", () => {
  it("documents adoption requirements in docs/agent-development-workbench.md", async () => {
    await access(adoptionDocPath);
    const doc = await readFile(adoptionDocPath, "utf8");
    for (const requirement of adoptionRequirements)
      expect(doc, `missing adoption doc requirement: ${requirement}`).toContain(
        requirement
      );
  });

  it("publishes the six approved package scripts exactly", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const [name, command] of Object.entries(expected))
      expect(pkg.scripts[name]).toBe(command);
  });

  it.each(Object.keys(expected))(
    "dispatches npm run %s through the CLI in contract mode",
    async (name) => {
      const executable =
        process.platform === "win32"
          ? (process.env.ComSpec ?? "cmd.exe")
          : "npm";
      const args =
        process.platform === "win32"
          ? ["/d", "/s", "/c", `npm run ${name} -- --contract`]
          : ["run", name, "--", "--contract"];
      const { stdout } = await execute(executable, args, {
        cwd: process.cwd(),
        windowsHide: true
      });
      expect(stdout).toContain('"action"');
    }
  );
});
