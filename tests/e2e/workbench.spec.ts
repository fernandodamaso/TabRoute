import { access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildExtension } from "../../scripts/workbench/build";
import {
  launchExtensionSession,
  type ExtensionSession
} from "../../scripts/workbench/browser";
import { runWorkbench } from "../../scripts/workbench/runner";
import {
  SCENARIO_DEFINITIONS,
  getScenarioDefaultUrlState,
  getScenarioDefinition
} from "../../src/workbench/scenarios";
import { serializeWorkbenchUrl } from "../../src/workbench/url";
import type { ManagerTransportRecord } from "../../src/ui/manager/types";

const profileRoot = path.join(os.tmpdir(), "tabroute-workbench");
const MANAGER_READY_TIMEOUT = 15_000;

interface FixtureSession {
  session: ExtensionSession;
  profilePath: string;
  buildRunId: string;
}

async function createFixtureSession(): Promise<FixtureSession> {
  const buildRunId = `e2e-fixture-${crypto.randomUUID()}`;
  const profilePath = path.join(profileRoot, crypto.randomUUID());
  const build = await buildExtension({
    worktreePath: process.cwd(),
    runId: buildRunId,
    graph: "workbench"
  });
  const session = await launchExtensionSession({
    buildPath: build.buildPath,
    profilePath,
    headless: true
  });
  return { session, profilePath, buildRunId };
}

async function disposeFixtureSession(input: FixtureSession): Promise<void> {
  await input.session.close();
  await rm(input.profilePath, { recursive: true, force: true });
}

function scenarioUrl(extensionId: string, scenarioId: string): string {
  const state = getScenarioDefaultUrlState(scenarioId);
  return `chrome-extension://${extensionId}/options.html${serializeWorkbenchUrl(state)}`;
}

async function openScenario(
  page: Page,
  extensionId: string,
  scenarioId: string
): Promise<void> {
  await page.goto(scenarioUrl(extensionId, scenarioId));
  const scenario = getScenarioDefinition(scenarioId);
  if (scenario.id === "wb:loading") {
    await expect(
      page.locator('[data-workbench-status="manager-pending"]')
    ).toBeVisible({ timeout: MANAGER_READY_TIMEOUT });
    await page
      .getByRole("button", { name: "Release pending response" })
      .click();
    await page.waitForSelector('[data-workbench-status="manager-ready"]', {
      timeout: MANAGER_READY_TIMEOUT
    });
    return;
  }
  if (scenario.id === "wb:validation-error") {
    await page.waitForSelector('[data-workbench-status="manager-ready"]', {
      timeout: MANAGER_READY_TIMEOUT
    });
    return;
  }
  const statusSelector =
    scenario.expected.status === "error"
      ? '[data-workbench-status="manager-error"]'
      : '[data-workbench-status="manager-ready"]';
  await page.waitForSelector(statusSelector, {
    timeout: MANAGER_READY_TIMEOUT
  });
}

async function assertScenarioPublicState(
  page: Page,
  scenarioId: string
): Promise<void> {
  const scenario = getScenarioDefinition(scenarioId);
  const preview = page.locator(".workbench-preview");
  if (
    scenario.expected.heading !== "Groups" ||
    scenario.id !== "wb:empty-groups"
  ) {
    await expect(
      preview.getByRole("heading", { name: scenario.expected.heading })
    ).toBeVisible();
  }
  for (const snippet of scenario.expected.snippets ?? []) {
    if (scenario.id === "wb:mixed-rules-overview") {
      await expect(
        preview.locator(".rule-status-active").first()
      ).toBeVisible();
      continue;
    }
    if (scenario.id === "wb:empty-groups") {
      await expect(
        preview.getByRole("heading", { name: "Other" })
      ).toBeVisible();
      continue;
    }
    if (scenario.id === "wb:populated-persistent-tabs") {
      await preview
        .locator(".groups-list button")
        .filter({ hasText: "Work" })
        .first()
        .click();
      await expect(
        preview.getByRole("listitem").filter({ hasText: "docs.example.test" })
      ).toBeVisible();
      continue;
    }
    await expect(preview.getByText(snippet, { exact: false })).toBeVisible();
  }
  if (scenario.expected.dialogTitle) {
    await expect(
      preview.getByRole("dialog", { name: scenario.expected.dialogTitle })
    ).toBeVisible();
  }
  if (scenario.id === "wb:validation-error") {
    await preview.getByRole("button", { name: "Save rule" }).click();
    await expect(preview.getByRole("alert")).toContainText(
      "Fixture validation failure"
    );
    return;
  }
  const status = await page
    .locator("[data-workbench-status]")
    .getAttribute("data-workbench-status");
  if (scenario.expected.status === "error")
    expect(status).toBe("manager-error");
  else expect(status).toBe("manager-ready");
}

async function previewDimensions(
  page: Page
): Promise<{ width: number; height: number }> {
  const preview = page.locator(".workbench-preview");
  return preview.evaluate((element) => {
    const computed = window.getComputedStyle(element);
    return {
      width: Number.parseFloat(computed.width),
      height: Number.parseFloat(computed.height)
    };
  });
}

async function readCommandRecords(
  page: Page
): Promise<ManagerTransportRecord[]> {
  await page.locator(".workbench-command-log summary").click();
  const text = await page.locator(".workbench-command-log pre").textContent();
  if (!text) return [];
  return JSON.parse(text) as ManagerTransportRecord[];
}

test("headless worker discovery", async () => {
  const fixture = await createFixtureSession();
  try {
    expect(fixture.session.extensionId).toMatch(/^[a-p]{32}$/);
    expect(fixture.session.workerGenerations.length).toBeGreaterThanOrEqual(0);
  } finally {
    await disposeFixtureSession(fixture);
  }
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
    expect(result.url).toContain(
      `chrome-extension://${result.extensionId}/options.html`
    );
    expect(result.screenshotPaths.length).toBeGreaterThan(0);
    const screenshotName = result.screenshotPaths[0];
    if (!screenshotName) throw new Error("missing screenshot path");
    const screenshot = path.join(
      process.cwd(),
      ".workbench",
      "artifacts",
      result.runId,
      screenshotName
    );
    await access(screenshot);
    const previewAssertion = result.assertions.find(
      (assertion) => assertion.name === "workbench-preview-dimensions"
    );
    expect(previewAssertion?.passed).toBe(true);
    expect(previewAssertion?.details).toMatchObject({
      width: 520,
      height: 600
    });
    expect(result.cleanup.profileRemoved).toBe(true);
    const resultPath = path.join(
      process.cwd(),
      ".workbench",
      "artifacts",
      result.runId,
      "results.json"
    );
    const persisted = JSON.parse(await readFile(resultPath, "utf8")) as {
      runId: string;
      extensionId: string;
    };
    expect(persisted.runId).toBe(result.runId);
    expect(persisted.extensionId).toBe(result.extensionId);
    const logPath = path.join(
      process.cwd(),
      ".workbench",
      "artifacts",
      result.runId,
      "runner.log"
    );
    await access(logPath);
  } else {
    throw new Error(`workbench run failed: ${JSON.stringify(result)}`);
  }
});

for (const scenario of SCENARIO_DEFINITIONS) {
  test(`fixture scenario ${scenario.id}`, async () => {
    const fixture = await createFixtureSession();
    const page = await fixture.session.context.newPage();
    try {
      await openScenario(page, fixture.session.extensionId, scenario.id);
      await assertScenarioPublicState(page, scenario.id);
      const dimensions = await previewDimensions(page);
      expect(dimensions).toEqual({ width: 520, height: 600 });
    } finally {
      await page.close();
      await disposeFixtureSession(fixture);
    }
  });
}

test("route navigation and route focus", async () => {
  const fixture = await createFixtureSession();
  const page = await fixture.session.context.newPage();
  try {
    await openScenario(page, fixture.session.extensionId, "wb:default");
    const routes = [
      { label: "Rules", heading: "Rules", focus: "rules" },
      { label: "Activity", heading: "Activity", focus: "activity" },
      { label: "Settings", heading: "Settings", focus: "settings" },
      { label: "Groups", heading: "Groups", focus: "groups" }
    ] as const;
    for (const route of routes) {
      await page.getByLabel("Route").selectOption(route.label);
      await expect(
        page
          .locator(".workbench-preview")
          .getByRole("heading", { name: route.heading })
      ).toBeVisible();
      await expect
        .poll(async () =>
          page
            .locator(`main[data-route-focus="${route.focus}"]`)
            .evaluate((element) => element === document.activeElement)
        )
        .toBe(true);
    }
  } finally {
    await page.close();
    await disposeFixtureSession(fixture);
  }
});

test("deep links open the expected editor and confirmation overlay", async () => {
  const fixture = await createFixtureSession();
  const page = await fixture.session.context.newPage();
  try {
    await openScenario(page, fixture.session.extensionId, "wb:new-rule");
    await expect(page.getByRole("heading", { name: "New rule" })).toBeVisible();
    await page.goto(scenarioUrl(fixture.session.extensionId, "wb:edit-rule"));
    await page.waitForSelector('[data-workbench-status="manager-ready"]', {
      timeout: MANAGER_READY_TIMEOUT
    });
    await expect(
      page.getByRole("heading", { name: "Edit rule" })
    ).toBeVisible();
    await page.goto(
      scenarioUrl(fixture.session.extensionId, "wb:confirmation-overlay")
    );
    await page.waitForSelector('[data-workbench-status="manager-ready"]', {
      timeout: MANAGER_READY_TIMEOUT
    });
    await expect(
      page.getByRole("dialog", { name: "Delete rule?" })
    ).toBeVisible();
  } finally {
    await page.close();
    await disposeFixtureSession(fixture);
  }
});

test("header and primary navigation stay fixed while feature bodies scroll", async () => {
  const fixture = await createFixtureSession();
  const page = await fixture.session.context.newPage();
  try {
    await openScenario(page, fixture.session.extensionId, "wb:dense-groups");
    const headerOverflow = await page
      .locator(".manager-header")
      .evaluate((element) => window.getComputedStyle(element).overflowY);
    const navOverflow = await page
      .locator(".manager-primary-nav")
      .evaluate((element) => window.getComputedStyle(element).overflowY);
    expect(headerOverflow).not.toBe("auto");
    expect(headerOverflow).not.toBe("scroll");
    expect(navOverflow).not.toBe("auto");
    expect(navOverflow).not.toBe("scroll");
    const groupsListScrollable = await page
      .locator(".groups-list")
      .evaluate((element) => element.scrollHeight > element.clientHeight);
    const inspectorScrollable = await page
      .locator(".groups-inspector")
      .evaluate((element) => element.scrollHeight > element.clientHeight);
    expect(groupsListScrollable || inspectorScrollable).toBe(true);

    await page.getByLabel("Route").selectOption("Rules");
    await page.waitForSelector('[data-workbench-status="manager-ready"]', {
      timeout: MANAGER_READY_TIMEOUT
    });
    await page.getByLabel("Scenario").selectOption("wb:mixed-rules-overview");
    await page.waitForSelector('[data-workbench-status="manager-ready"]', {
      timeout: MANAGER_READY_TIMEOUT
    });
    const rulesScrollable = await page
      .locator(".workbench-preview .manager-page-scroll")
      .evaluate((element) => element.scrollHeight > element.clientHeight);
    expect(rulesScrollable).toBe(true);
  } finally {
    await page.close();
    await disposeFixtureSession(fixture);
  }
});

test("confirmation overlay traps focus and Escape restores it", async () => {
  const fixture = await createFixtureSession();
  const page = await fixture.session.context.newPage();
  try {
    await openScenario(
      page,
      fixture.session.extensionId,
      "wb:confirmation-overlay"
    );
    const preview = page.locator(".workbench-preview");
    const dialog = preview.getByRole("dialog", { name: "Delete rule?" });
    await expect(dialog).toBeVisible();
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const confirm = dialog.getByRole("button", { name: "Delete rule" });
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect
      .poll(async () =>
        preview
          .locator(".confirmation-dialog")
          .evaluate((element) => element.contains(document.activeElement))
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(preview.getByRole("heading", { name: "Rules" })).toBeVisible();
  } finally {
    await page.close();
    await disposeFixtureSession(fixture);
  }
});

test("latency failure reset and command records stay ordered", async () => {
  const fixture = await createFixtureSession();
  const page = await fixture.session.context.newPage();
  try {
    await openScenario(page, fixture.session.extensionId, "wb:slow");
    let records = await readCommandRecords(page);
    const queryRecord = records.find(
      (
        record
      ): record is Extract<ManagerTransportRecord, { recordType: "request" }> =>
        record.recordType === "request" &&
        record.message.kind === "manager-query"
    );
    expect(queryRecord?.latencyMs).toBeGreaterThanOrEqual(250);

    const failingState = getScenarioDefaultUrlState("wb:default");
    failingState.failure = { mode: "query", scope: "once" };
    await page.goto(
      `chrome-extension://${fixture.session.extensionId}/options.html${serializeWorkbenchUrl(failingState)}`
    );
    await page.waitForSelector('[data-workbench-status="manager-error"]', {
      timeout: MANAGER_READY_TIMEOUT
    });
    records = await readCommandRecords(page);
    const rejected = records.filter(
      (record) => record.recordType === "request" && record.state === "rejected"
    );
    expect(rejected.length).toBeGreaterThan(0);
    const sequences = records
      .filter(
        (
          record
        ): record is Extract<
          ManagerTransportRecord,
          { recordType: "request" }
        > => record.recordType === "request"
      )
      .map((record) => record.sequence);
    expect(sequences).toEqual(
      [...sequences].sort((left, right) => left - right)
    );

    await page.getByLabel("Failure mode").selectOption("none");
    const recoveredState = getScenarioDefaultUrlState("wb:default");
    recoveredState.latencyMs = 100;
    await page.goto(
      `chrome-extension://${fixture.session.extensionId}/options.html${serializeWorkbenchUrl(recoveredState)}`
    );
    await page.waitForSelector('[data-workbench-status="manager-ready"]', {
      timeout: MANAGER_READY_TIMEOUT
    });
    records = await readCommandRecords(page);
    const latestQuery = [...records]
      .reverse()
      .find(
        (
          record
        ): record is Extract<
          ManagerTransportRecord,
          { recordType: "request"; state: "resolved" }
        > =>
          record.recordType === "request" &&
          record.message.kind === "manager-query" &&
          record.state === "resolved"
      );
    expect(latestQuery?.latencyMs).toBe(100);
  } finally {
    await page.close();
    await disposeFixtureSession(fixture);
  }
});

test("reset restores the fixture session after controls change", async () => {
  const fixture = await createFixtureSession();
  const page = await fixture.session.context.newPage();
  try {
    await openScenario(page, fixture.session.extensionId, "wb:default");
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(
      page.locator('[data-workbench-status="manager-ready"]')
    ).toBeVisible({ timeout: MANAGER_READY_TIMEOUT });
    const records = await readCommandRecords(page);
    expect(
      records.some(
        (record) =>
          record.recordType === "request" &&
          record.message.kind === "manager-query"
      )
    ).toBe(true);
  } finally {
    await page.close();
    await disposeFixtureSession(fixture);
  }
});

test("loading scenario stays pending until release", async () => {
  const fixture = await createFixtureSession();
  const page = await fixture.session.context.newPage();
  try {
    await page.goto(scenarioUrl(fixture.session.extensionId, "wb:loading"));
    await expect(
      page.locator('[data-workbench-status="manager-pending"]')
    ).toBeVisible();
    await expect(page.getByText("Loading", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Release pending response" })
      .click();
    await page.waitForSelector('[data-workbench-status="manager-ready"]', {
      timeout: MANAGER_READY_TIMEOUT
    });
    await expect(
      page
        .locator(".workbench-preview")
        .getByRole("heading", { name: "Groups" })
    ).toBeVisible();
  } finally {
    await page.close();
    await disposeFixtureSession(fixture);
  }
});
