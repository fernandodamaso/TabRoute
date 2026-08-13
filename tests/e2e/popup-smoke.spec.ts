import { access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildExtension } from "../../scripts/workbench/build";
import { launchExtensionSession } from "../../scripts/workbench/browser";
const profileRoot = path.join(os.tmpdir(), "tabroute-workbench");

async function resolveProductionBuildPath(): Promise<string> {
  const fromEnv = process.env.TABROUTE_PRODUCTION_BUILD_PATH;
  if (fromEnv) return fromEnv;
  const runId = `popup-smoke-${crypto.randomUUID()}`;
  const build = await buildExtension({
    worktreePath: process.cwd(),
    runId,
    graph: "production"
  });
  return build.buildPath;
}

test("popup smoke renders ManagerApp at 520x600 without workbench controls", async () => {
  const buildPath = await resolveProductionBuildPath();
  const runId = `popup-${crypto.randomUUID()}`;
  const profilePath = path.join(profileRoot, runId);
  const artifactPath = path.join(
    process.cwd(),
    ".workbench",
    "artifacts",
    runId
  );
  const session = await launchExtensionSession({
    buildPath,
    profilePath,
    headless: true
  });
  const page = await session.context.newPage();
  try {
    await page.goto(`chrome-extension://${session.extensionId}/popup.html`);
    await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
    expect(
      await page.locator("html").getAttribute("data-manager-viewport")
    ).toBe("520x600");
    const dimensions = await page.evaluate(() => ({
      width: Number.parseFloat(
        getComputedStyle(document.documentElement).width
      ),
      height: Number.parseFloat(
        getComputedStyle(document.documentElement).height
      )
    }));
    expect(dimensions).toEqual({ width: 520, height: 600 });
    expect(await page.locator("[data-workbench-marker]").count()).toBe(0);
    expect(await page.locator("[data-workbench-control]").count()).toBe(0);

    await import("node:fs/promises").then((fs) =>
      fs.mkdir(artifactPath, { recursive: true })
    );
    const screenshotRelative = "screenshots/popup-smoke.png";
    const screenshotAbsolute = path.join(artifactPath, screenshotRelative);
    await page.screenshot({ path: screenshotAbsolute, type: "png" });
    await access(screenshotAbsolute);

    const result = {
      ok: true,
      status: "completed",
      runId,
      extensionId: session.extensionId,
      buildPath,
      profilePath,
      screenshotPaths: [screenshotRelative]
    };
    const resultPath = path.join(artifactPath, "results.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(resultPath, JSON.stringify(result, null, 2), "utf8")
    );
    const persisted = JSON.parse(await readFile(resultPath, "utf8")) as {
      runId: string;
      extensionId: string;
    };
    expect(persisted.runId).toBe(runId);
    expect(persisted.extensionId).toBe(session.extensionId);
  } finally {
    await page.close();
    await session.close();
    await rm(profilePath, { recursive: true, force: true });
  }
});
