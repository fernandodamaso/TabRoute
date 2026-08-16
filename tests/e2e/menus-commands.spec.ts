import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
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
const MANAGER_AFTER_WORKER_RESTART_TIMEOUT_MS =
  MANAGER_SETTLE_TIMEOUT_MS +
  WORKER_DISCOVERY_TIMEOUT_MS +
  MANAGER_QUERY_TIMEOUT_MS;

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

async function readWakeListenerState(
  session: Awaited<ReturnType<typeof launchExtensionSession>>
) {
  const worker = await waitForWorker(session);
  return worker.evaluate(() => ({
    contextMenuClick: chrome.contextMenus.onClicked.hasListeners(),
    manifestCommand: chrome.commands.onCommand.hasListeners(),
    managerMessage: chrome.runtime.onMessage.hasListeners()
  }));
}

async function sendProductionE2eMessage(
  page: Page,
  message: Record<string, unknown>
): Promise<unknown> {
  return page.evaluate(async (payload) => {
    return await new Promise<unknown>((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError?.message) reject(new Error(lastError.message));
        else resolve(response);
      });
    });
  }, message);
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

test("worker restart synchronously restores wake listeners and stable menu IDs", async () => {
  const { session, profilePath } =
    await launchProductionSession("menus-restart");
  try {
    const options = await awakenWorker(session);
    expect(await readWakeListenerState(session)).toEqual({
      contextMenuClick: true,
      manifestCommand: true,
      managerMessage: true
    });
    expect(await menuUpdateSucceeds(session, "tabroute:create-rule")).toEqual({
      ok: true
    });

    await session.restartWorker();

    expect(await readWakeListenerState(session)).toEqual({
      contextMenuClick: true,
      manifestCommand: true,
      managerMessage: true
    });
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

test("worker termination wakes the context-menu action handler", async () => {
  const { session, profilePath } = await launchProductionSession(
    "menus-context-action-restart"
  );
  const page = await session.context.newPage();
  try {
    await page.goto("https://example.com/");
    await page.waitForLoadState("domcontentloaded");
    const trigger = await session.openExtensionPage("options.html");
    await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(trigger)
    });
    await session.restartWorker();

    const tab = await trigger.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((candidate) => candidate.url === "https://example.com/");
    });
    expect(tab?.id).toBeDefined();
    const result = await sendProductionE2eMessage(trigger, {
      kind: "__tabroute_e2e_context_menu",
      info: {
        menuItemId: "tabroute:create-rule",
        editable: false,
        pageUrl: "https://example.com/"
      },
      tab
    });
    expect(result).toEqual({ ok: true });
    const final = await sendManagerQueryFromPage(trigger);
    expect(final).toMatchObject({
      ok: true,
      viewFixture: {
        pendingRuleDraft: {
          host: "example.com",
          url: "https://example.com/"
        }
      }
    });
    await trigger.close();
  } finally {
    await page.close();
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});

test("worker termination wakes the manifest command handler", async () => {
  const { session, profilePath } = await launchProductionSession(
    "menus-command-action-restart"
  );
  const page = await session.context.newPage();
  try {
    await page.goto("https://example.com/");
    await page.waitForLoadState("domcontentloaded");
    const trigger = await session.openExtensionPage("options.html");
    const initial = await sendManagerQueryFromPage(trigger);
    expect(initial).toMatchObject({
      ok: true,
      configuration: { automationEnabled: true }
    });
    await session.restartWorker();

    const tab = await trigger.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((candidate) => candidate.url === "https://example.com/");
    });
    expect(tab?.id).toBeDefined();
    const result = await sendProductionE2eMessage(trigger, {
      kind: "__tabroute_e2e_manifest_command",
      command: "toggle-automation",
      tab
    });
    expect(result).toEqual({ ok: true });
    const final = await sendManagerQueryFromPage(trigger);
    expect(final).toMatchObject({
      ok: true,
      configuration: { automationEnabled: false }
    });
    await trigger.close();
  } finally {
    await page.close();
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});

test("Manager opened after worker termination loads real configuration", async () => {
  const { session, profilePath } = await launchProductionSession(
    "manager-open-after-restart"
  );
  const page = await session.context.newPage();
  try {
    await page.goto("https://example.com/");
    await page.waitForLoadState("domcontentloaded");
    const wakePage = await session.openExtensionPage("options.html");
    await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(wakePage)
    });
    await session.restartWorker();

    // This is a fresh Manager page. The setup page above is not reused.
    const manager = await session.openExtensionPage("options.html");
    const { response } = await settleManagerQuery({
      timeoutMs: MANAGER_AFTER_WORKER_RESTART_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(manager)
    });
    expect(response).toMatchObject({ ok: true });
    await expect(
      manager.getByRole("heading", { name: "Groups" })
    ).toBeVisible();
    await wakePage.close();
    await manager.close();
  } finally {
    await page.close();
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});
