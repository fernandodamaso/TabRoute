import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchExtensionSession,
  sendManagerQueryFromPage
} from "../../scripts/workbench/browser";
import {
  MANAGER_QUERY_TIMEOUT_MS,
  settleManagerQuery,
  WORKER_DISCOVERY_TIMEOUT_MS
} from "../../scripts/workbench/readiness";

const MANAGER_SETTLE_TIMEOUT_MS = Math.max(
  MANAGER_QUERY_TIMEOUT_MS,
  WORKER_DISCOVERY_TIMEOUT_MS
);

const profileRoot = path.join(os.tmpdir(), "tabroute-workbench");

function requireProductionBuildPath(): string {
  const buildPath = process.env.TABROUTE_PRODUCTION_BUILD_PATH;
  if (!buildPath) throw new Error("TABROUTE_PRODUCTION_BUILD_PATH is required");
  return buildPath;
}

test("settings restore persistent groups toggle keeps manager healthy", async () => {
  const buildPath = requireProductionBuildPath();
  const profilePath = path.join(
    profileRoot,
    `startup-settings-${crypto.randomUUID()}`
  );
  const session = await launchExtensionSession({
    buildPath,
    profilePath,
    headless: true
  });
  const page = await session.context.newPage();
  try {
    await page.goto(`chrome-extension://${session.extensionId}/options.html#settings`);
    await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    const checkbox = page.getByLabel("Restore persistent groups");
    await expect(checkbox).toBeChecked();
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    const { response } = await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    expect(response).toMatchObject({
      ok: true,
      configuration: { restorePersistentGroups: false }
    });
  } finally {
    await page.close();
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});
