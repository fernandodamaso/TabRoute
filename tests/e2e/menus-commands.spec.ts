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

async function launchProductionSession(profileSuffix: string) {
  const buildPath = requireProductionBuildPath();
  const profilePath = path.join(
    profileRoot,
    `${profileSuffix}-${crypto.randomUUID()}`
  );
  const session = await launchExtensionSession({
    buildPath,
    profilePath,
    headless: true
  });
  return { session, profilePath };
}

async function waitForWorker(
  session: Awaited<ReturnType<typeof launchExtensionSession>>
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const workers = session.context.serviceWorkers();
    if (workers.length > 0) return workers[0]!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("extension service worker not found");
}

async function awakenWorker(
  session: Awaited<ReturnType<typeof launchExtensionSession>>
) {
  const page = await session.context.newPage();
  await page.goto(`chrome-extension://${session.extensionId}/options.html`);
  await settleManagerQuery({
    timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
    request: () => sendManagerQueryFromPage(page)
  });
  return page;
}

async function menuUpdateSucceeds(
  session: Awaited<ReturnType<typeof launchExtensionSession>>,
  menuId: string
): Promise<{ ok: boolean; error?: string }> {
  const worker = await waitForWorker(session);
  return worker.evaluate(async (id) => {
    try {
      await new Promise<void>((resolve, reject) => {
        chrome.contextMenus.update(id, {}, () => {
          const error = chrome.runtime.lastError;
          if (error?.message) reject(new Error(error.message));
          else resolve();
        });
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }, menuId);
}

test("registers page, tab, and group menu IDs in an isolated profile", async () => {
  const { session, profilePath } = await launchProductionSession("menus");
  try {
    const options = await awakenWorker(session);
    const page = await session.context.newPage();
    await page.goto("https://example.com/");
    await page.waitForLoadState("domcontentloaded");
    for (const id of [
      "tabroute:create-rule",
      "tabroute:move-other",
      "tabroute:pin-group",
      "tabroute:collapse-group",
      "tabroute:save-snapshot"
    ]) {
      const result = await menuUpdateSucceeds(session, id);
      expect(result, id).toEqual({ ok: true });
    }
    await page.close();
    await options.close();
  } finally {
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});

test("worker restart re-registers stable menu IDs", async () => {
  const { session, profilePath } =
    await launchProductionSession("menus-restart");
  try {
    const options = await awakenWorker(session);
    expect(await menuUpdateSucceeds(session, "tabroute:create-rule")).toEqual({
      ok: true
    });
    await session.restartWorker();
    expect(await menuUpdateSucceeds(session, "tabroute:create-rule")).toEqual({
      ok: true
    });
    const worker = await waitForWorker(session);
    const commands = await worker.evaluate(async () =>
      chrome.commands.getAll()
    );
    expect(
      commands
        .map((command) => command.name)
        .filter((name) => name && !name.startsWith("_"))
        .sort()
    ).toEqual([
      "create-rule-from-tab",
      "make-persistent",
      "move-to-other",
      "open-manager",
      "pin-group",
      "remove-persistent",
      "save-snapshot",
      "toggle-automation",
      "undo"
    ]);
    await options.close();
  } finally {
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});
