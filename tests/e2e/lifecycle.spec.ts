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

test("delayed committed URL navigation keeps manager query healthy", async () => {
  const { session, profilePath } =
    await launchProductionSession("lifecycle-loading");
  const page = await session.context.newPage();
  try {
    await page.goto(`chrome-extension://${session.extensionId}/options.html`);
    await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    const routed = await session.context.newPage();
    await routed.goto("https://example.com/");
    await routed.waitForLoadState("domcontentloaded");
    const { response } = await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    expect(response).toMatchObject({ ok: true });
    await routed.close();
  } finally {
    await page.close();
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});

test("worker restart with routed tab keeps manager query healthy", async () => {
  const { session, profilePath } =
    await launchProductionSession("lifecycle-restart");
  const page = await session.context.newPage();
  try {
    await page.goto(`chrome-extension://${session.extensionId}/options.html`);
    await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    const routed = await session.context.newPage();
    await routed.goto("https://example.com/");
    await routed.waitForLoadState("domcontentloaded");
    const restart = await session.restartWorker();
    expect(restart.terminatedTargetId).toBeTruthy();
    expect(restart.awakenedTargetId).toBeTruthy();
    const { response } = await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    expect(response).toMatchObject({ ok: true });
    await routed.close();
  } finally {
    await page.close();
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});

test("native group rename does not duplicate fallback groups", async () => {
  const { session, profilePath } =
    await launchProductionSession("lifecycle-native-group");
  const page = await session.context.newPage();
  try {
    await page.goto(`chrome-extension://${session.extensionId}/options.html`);
    const { response: initial } = await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    expect(initial).toMatchObject({ ok: true });
    const initialGroupCount = (
      initial as { configuration: { groups: unknown[] } }
    ).configuration.groups.length;

    const first = await session.context.newPage();
    await first.goto("https://example.com/one");
    await first.waitForLoadState("domcontentloaded");
    const second = await session.context.newPage();
    await second.goto("https://example.com/two");
    await second.waitForLoadState("domcontentloaded");

    await page.evaluate(async () => {
      const chromeApi = (
        globalThis as typeof globalThis & {
          chrome: typeof chrome;
        }
      ).chrome;
      const tabs = await chromeApi.tabs.query({
        url: ["https://example.com/*"]
      });
      const tabIds = tabs
        .map((tab) => tab.id)
        .filter((id): id is number => id !== undefined);
      if (tabIds.length < 2) throw new Error("expected two example tabs");
      const groupId = await chromeApi.tabs.group({ tabIds });
      await chromeApi.tabGroups.update(groupId, { title: "Native Test" });
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const { response: after } = await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    expect(after).toMatchObject({ ok: true });
    expect(
      (after as { configuration: { groups: unknown[] } }).configuration.groups
        .length
    ).toBe(initialGroupCount);

    await first.close();
    await second.close();
  } finally {
    await page.close();
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});
