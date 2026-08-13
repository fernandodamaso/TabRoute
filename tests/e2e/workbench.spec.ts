import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildExtension } from "../../scripts/workbench/build";
import { launchExtensionSession } from "../../scripts/workbench/browser";
import { runWorkbench } from "../../scripts/workbench/runner";

const profileRoot = path.join(os.tmpdir(), "tabroute-workbench");

test("headless worker discovery", async () => {
  const runId = `e2e-worker-${crypto.randomUUID()}`;
  const profilePath = path.join(profileRoot, runId);
  const build = await buildExtension({ worktreePath: process.cwd(), runId, graph: "workbench" });
  const session = await launchExtensionSession({
    buildPath: build.buildPath,
    profilePath,
    headless: true
  });
  expect(session.extensionId).toMatch(/^[a-p]{32}$/);
  expect(session.workerGenerations.length).toBeGreaterThanOrEqual(0);
  await session.close();
  await import("node:fs/promises").then((fs) => fs.rm(profilePath, { recursive: true, force: true }));
});

test("default scenario", async () => {
  const result = await runWorkbench({
    worktreePath: process.cwd(),
    mode: "fixture",
    entryPoint: "options.html",
    scenario: "wb:default",
    once: true,
    headless: true
  });
  expect(result.runId).toBeTruthy();
  if (result.ok && result.status === "completed") {
    expect(result.extensionId).toMatch(/^[a-p]{32}$/);
    expect(result.url).toContain(`chrome-extension://${result.extensionId}/options.html`);
    expect(result.screenshotPaths.length).toBeGreaterThan(0);
    const screenshotName = result.screenshotPaths[0];
    if (!screenshotName) throw new Error("missing screenshot path");
    const screenshot = path.join(process.cwd(), ".workbench", "artifacts", result.runId, screenshotName);
    await access(screenshot);
    const previewAssertion = result.assertions.find((assertion) => assertion.name === "workbench-preview-dimensions");
    expect(previewAssertion?.passed).toBe(true);
    expect(previewAssertion?.details).toMatchObject({ width: 520, height: 600 });
    expect(result.cleanup.profileRemoved).toBe(true);
    const resultPath = path.join(process.cwd(), ".workbench", "artifacts", result.runId, "results.json");
    const persisted = JSON.parse(await readFile(resultPath, "utf8")) as { runId: string; extensionId: string };
    expect(persisted.runId).toBe(result.runId);
    expect(persisted.extensionId).toBe(result.extensionId);
  } else {
    throw new Error(`workbench run failed: ${JSON.stringify(result)}`);
  }
});
