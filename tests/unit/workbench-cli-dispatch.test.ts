import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const cli = path.resolve("scripts/workbench/cli.ts");

async function contract(...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execute(process.execPath, ["--import", "tsx", cli, ...args, "--contract"], {
    cwd: process.cwd(),
    windowsHide: true
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("workbench CLI dispatch", () => {
  it.each([
    [["build-workbench"], { command: "build-workbench", action: "build", graph: "workbench" }],
    [["workbench", "--mode", "fixture"], { command: "workbench", action: "run", graph: "workbench", mode: "fixture", entryPoint: "options.html", scenario: "wb:default" }],
    [["workbench", "--mode", "real"], { command: "workbench", action: "run", graph: "workbench", mode: "real", entryPoint: "options.html", scenario: "wb:default" }],
    [["test-workbench"], { command: "test-workbench", action: "playwright", spec: "tests/e2e/workbench.spec.ts" }],
    [["test-extension"], { command: "test-extension", action: "production-gate" }],
    [["smoke-popup"], { command: "smoke-popup", action: "playwright", spec: "tests/e2e/popup-smoke.spec.ts" }]
  ])("dispatches %s without starting a browser", async (args, expected) => {
    await expect(contract(...args)).resolves.toMatchObject(expected);
  });

  it("rejects an unsupported command instead of falling through", async () => {
    await expect(contract("unknown-command")).rejects.toMatchObject({ code: expect.any(Number) });
  });
});
