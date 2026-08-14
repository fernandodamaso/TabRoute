import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";
import { buildExtension } from "../../scripts/workbench/build";
import {
  launchExtensionSession,
  sendManagerQueryFromPage,
  type ExtensionSession
} from "../../scripts/workbench/browser";
import {
  MANAGER_QUERY_TIMEOUT_MS,
  settleManagerQuery,
  WORKER_DISCOVERY_TIMEOUT_MS
} from "../../scripts/workbench/readiness";

export const MANAGER_SETTLE_TIMEOUT_MS = Math.max(
  MANAGER_QUERY_TIMEOUT_MS,
  WORKER_DISCOVERY_TIMEOUT_MS
);

export const CANONICAL_FRAMES_DIR = path.join(
  process.cwd(),
  "tests",
  "e2e",
  "canonical-frames"
);

export const CANONICAL_FRAMES = [
  {
    nodeId: "39:2",
    stem: "39-2-groups",
    route: "groups",
    heading: "Groups",
    scrollerSelector: ".groups-inspector"
  },
  {
    nodeId: "42:2",
    stem: "42-2-rules-overview",
    route: "rules",
    heading: "Rules",
    scrollerSelector: ".manager-page-scroll"
  },
  {
    nodeId: "42:3",
    stem: "42-3-rule-editor",
    route: "rules",
    heading: "New rule",
    scrollerSelector: ".manager-page-scroll"
  },
  {
    nodeId: "42:4",
    stem: "42-4-expanded-editor",
    route: "rules",
    heading: "New rule",
    scrollerSelector: ".manager-page-scroll"
  },
  {
    nodeId: "42:6",
    stem: "42-6-activity",
    route: "activity",
    heading: "Activity",
    scrollerSelector: ".manager-page-scroll"
  },
  {
    nodeId: "42:8",
    stem: "42-8-snapshots",
    route: "settings",
    heading: "Snapshots",
    scrollerSelector: ".manager-page-scroll",
    settingsPanel: "snapshots"
  },
  {
    nodeId: "214:1303",
    stem: "214-1303-settings",
    route: "settings",
    heading: "Settings",
    scrollerSelector: ".manager-page-scroll"
  },
  {
    nodeId: "42:11",
    stem: "42-11-diagnostics",
    route: "settings",
    heading: "Diagnostics",
    scrollerSelector: ".manager-page-scroll",
    settingsPanel: "diagnostics"
  },
  {
    nodeId: "90:312",
    stem: "90-312-rule-actions-menu",
    route: "rules",
    heading: "Rules",
    scrollerSelector: ".manager-page-scroll"
  },
  {
    nodeId: "91:348",
    stem: "91-348-delete-confirmation",
    route: "rules",
    heading: "Rules",
    scrollerSelector: ".manager-page-scroll"
  }
] as const;

export type CanonicalFrame = (typeof CANONICAL_FRAMES)[number];

const profileRoot = path.join(os.tmpdir(), "tabroute-workbench");

export async function resolveProductionBuildPath(): Promise<string> {
  const fromEnv = process.env.TABROUTE_PRODUCTION_BUILD_PATH;
  if (fromEnv) return fromEnv;
  const runId = `e2e-production-${crypto.randomUUID()}`;
  const build = await buildExtension({
    worktreePath: process.cwd(),
    runId,
    graph: "production"
  });
  return build.buildPath;
}

export type ProductionFixture = {
  session: ExtensionSession;
  page: Page;
  profilePath: string;
  buildPath: string;
  extensionId: string;
};

export const test = base.extend<{ production: ProductionFixture }>({
  production: async ({}, use) => {
    const buildPath = await resolveProductionBuildPath();
    const profilePath = path.join(
      profileRoot,
      `fdm-603-${crypto.randomUUID()}`
    );
    const session = await launchExtensionSession({
      buildPath,
      profilePath,
      headless: true
    });
    const page = await session.context.newPage();
    await use({
      session,
      page,
      profilePath,
      buildPath,
      extensionId: session.extensionId
    });
    await page.close().catch(() => undefined);
    await session.close().catch(() => undefined);
    await rm(profilePath, { recursive: true, force: true });
  }
});

export { expect };

export async function openPopup(fixture: ProductionFixture): Promise<void> {
  await fixture.page.setViewportSize({ width: 520, height: 600 });
  await fixture.page.goto(
    `chrome-extension://${fixture.extensionId}/popup.html`
  );
  await settleManagerQuery({
    timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
    request: () => sendManagerQueryFromPage(fixture.page)
  });
}

export async function openOptions(
  fixture: ProductionFixture,
  hash = ""
): Promise<void> {
  await fixture.page.setViewportSize({ width: 520, height: 600 });
  const suffix = hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "";
  await fixture.page.goto(
    `chrome-extension://${fixture.extensionId}/options.html${suffix}`
  );
  await settleManagerQuery({
    timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
    request: () => sendManagerQueryFromPage(fixture.page)
  });
}

export async function measureShell(page: Page): Promise<{
  viewport: { width: number; height: number };
  headerHeight: number;
  navigationHeight: number;
  bodyHeight: number;
  htmlOverflowY: string;
  bodyOverflowY: string;
}> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const header = document.querySelector(".manager-header");
    const nav = document.querySelector(".manager-primary-nav");
    const main = document.querySelector(".manager-page-scroll");
    if (!header || !nav || !main) throw new Error("manager shell missing");
    return {
      viewport: {
        width: Number.parseFloat(getComputedStyle(root).width),
        height: Number.parseFloat(getComputedStyle(root).height)
      },
      headerHeight: header.getBoundingClientRect().height,
      navigationHeight: nav.getBoundingClientRect().height,
      bodyHeight: main.getBoundingClientRect().height,
      htmlOverflowY: getComputedStyle(root).overflowY,
      bodyOverflowY: getComputedStyle(body).overflowY
    };
  });
}

export async function assertManagerStructure(page: Page): Promise<{
  viewport: { width: number; height: number };
  headerHeight: number;
  navigationHeight: number;
  bodyHeight: number;
}> {
  expect(await page.locator("html").getAttribute("data-manager-viewport")).toBe(
    "520x600"
  );
  const measured = await measureShell(page);
  expect(measured.viewport).toEqual({ width: 520, height: 600 });
  expect(measured.headerHeight).toBeCloseTo(52, 0);
  expect(measured.navigationHeight).toBeCloseTo(42, 0);
  expect(measured.bodyHeight).toBeCloseTo(506, 0);
  expect(measured.htmlOverflowY).not.toBe("auto");
  expect(measured.htmlOverflowY).not.toBe("scroll");
  expect(measured.bodyOverflowY).not.toBe("auto");
  expect(measured.bodyOverflowY).not.toBe("scroll");
  const headerInScroller = await page
    .locator(".manager-page-scroll .manager-header")
    .count();
  const navInScroller = await page
    .locator(".manager-page-scroll .manager-primary-nav")
    .count();
  expect(headerInScroller).toBe(0);
  expect(navInScroller).toBe(0);
  return {
    viewport: measured.viewport,
    headerHeight: measured.headerHeight,
    navigationHeight: measured.navigationHeight,
    bodyHeight: measured.bodyHeight
  };
}

export function primaryNavButton(page: Page, name: string) {
  return page.locator(".manager-primary-nav").getByRole("button", {
    name,
    exact: true
  });
}

export async function assertHistoricalSurfacesAbsent(
  page: Page
): Promise<void> {
  const navButtons = page.locator(".manager-primary-nav button");
  await expect(navButtons).toHaveCount(4);
  await expect(primaryNavButton(page, "Groups")).toBeVisible();
  await expect(primaryNavButton(page, "Rules")).toBeVisible();
  await expect(primaryNavButton(page, "Activity")).toBeVisible();
  await expect(primaryNavButton(page, "Settings")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Quick Actions", exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Templates", exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Suggestions", exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Persistent tabs", exact: true })
  ).toHaveCount(0);
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toMatch(/Quick Actions/);
  expect(bodyText).not.toMatch(/\bTemplates\b/);
  expect(bodyText).not.toMatch(/\bSuggestions\b/);
}

export async function ensureSavedRule(page: Page): Promise<void> {
  await primaryNavButton(page, "Rules").click();
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
  const existing = page.locator(".rule-row");
  if ((await existing.count()) > 0) return;
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByRole("heading", { name: "New rule" })).toBeVisible();
  const value = page.getByRole("textbox", { name: "Condition value 1" });
  await value.fill("example.com");
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
  await expect(page.locator(".rule-row").first()).toBeVisible();
}

export async function captureCanonicalFrame(
  page: Page,
  frame: CanonicalFrame,
  extras: Record<string, unknown> = {}
): Promise<void> {
  const structure = await assertManagerStructure(page);
  await mkdir(CANONICAL_FRAMES_DIR, { recursive: true });
  const pngPath = path.join(CANONICAL_FRAMES_DIR, `${frame.stem}.png`);
  const jsonPath = path.join(CANONICAL_FRAMES_DIR, `${frame.stem}.json`);
  const shell = page.locator(".manager-shell");
  await shell.screenshot({ path: pngPath, type: "png" });
  const payload = {
    nodeId: frame.nodeId,
    stem: frame.stem,
    route: frame.route,
    heading: frame.heading,
    settingsPanel:
      "settingsPanel" in frame ? frame.settingsPanel : ("root" as const),
    scrollerSelector: frame.scrollerSelector,
    viewport: structure.viewport,
    headerHeight: 52,
    navigationHeight: 42,
    bodyHeight: 506,
    measured: structure,
    ...extras
  };
  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await access(pngPath);
  await access(jsonPath);
}

export async function assertCanonicalEvidencePresent(): Promise<void> {
  for (const frame of CANONICAL_FRAMES) {
    const pngPath = path.join(CANONICAL_FRAMES_DIR, `${frame.stem}.png`);
    const jsonPath = path.join(CANONICAL_FRAMES_DIR, `${frame.stem}.json`);
    await access(pngPath);
    await access(jsonPath);
    const meta = JSON.parse(await readFile(jsonPath, "utf8")) as {
      nodeId: string;
      viewport: { width: number; height: number };
      headerHeight: number;
      navigationHeight: number;
      bodyHeight: number;
    };
    expect(meta.nodeId).toBe(frame.nodeId);
    expect(meta.viewport).toEqual({ width: 520, height: 600 });
    expect(meta.headerHeight).toBe(52);
    expect(meta.navigationHeight).toBe(42);
    expect(meta.bodyHeight).toBe(506);
  }
}

export async function compareCanonicalPngOnLinux(
  page: Page,
  frame: CanonicalFrame
): Promise<void> {
  if (process.platform !== "linux") return;
  await expect(page.locator(".manager-shell")).toHaveScreenshot(
    `${frame.stem}.png`,
    {
      maxDiffPixelRatio: 0.02
    }
  );
}
