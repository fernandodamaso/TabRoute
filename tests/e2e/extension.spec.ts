import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  buildExtension,
  resolveBuildOutput
} from "../../scripts/workbench/build";
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
import { readProductionGateResult } from "../../scripts/workbench/production-scan";

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
  return { session, profilePath, buildPath };
}

test("production gate result points at an existing production build", async () => {
  const gatePath = process.env.TABROUTE_PRODUCTION_GATE_RESULT_PATH;
  if (!gatePath)
    throw new Error("TABROUTE_PRODUCTION_GATE_RESULT_PATH is required");
  const gate = await readProductionGateResult(gatePath);
  expect(gate.graph).toBe("production");
  expect(gate.resultPath).toBe(path.resolve(gatePath));
  await access(gate.productionBuildPath);
  expect(gate.productionBuildPath).toBe(requireProductionBuildPath());
});

test("real options sends typed manager messages through the MV3 worker", async () => {
  const { session, profilePath } =
    await launchProductionSession("real-options");
  const page = await session.context.newPage();
  try {
    await page.goto(`chrome-extension://${session.extensionId}/options.html`);
    const { response: query } = await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    expect(query).toMatchObject({ ok: true });
    expect(
      await page.evaluate(
        () => document.querySelectorAll("[data-workbench-marker]").length
      )
    ).toBe(0);
    const invalid = await page.evaluate(async () => {
      const chromeApi = (
        globalThis as {
          chrome?: {
            runtime?: { sendMessage: (message: unknown) => Promise<unknown> };
          };
        }
      ).chrome;
      return chromeApi?.runtime?.sendMessage({
        kind: "manager-command",
        command: { kind: "deleteGroup", groupId: "not-a-valid-uuid" }
      });
    });
    expect(invalid).toMatchObject({ ok: false });
    const { response: preserved } = await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    expect(preserved).toMatchObject({ ok: true });
    expect((preserved as { configuration: unknown }).configuration).toEqual(
      (query as { configuration: unknown }).configuration
    );
  } finally {
    await page.close();
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});

test("worker restart survives CDP termination and wake-up", async () => {
  const { session, profilePath } =
    await launchProductionSession("worker-restart");
  const page = await session.context.newPage();
  try {
    await page.goto(`chrome-extension://${session.extensionId}/options.html`);
    await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    const restart = await session.restartWorker();
    expect(restart.terminatedTargetId).toBeTruthy();
    expect(restart.awakenedTargetId).toBeTruthy();
    const { response: second } = await settleManagerQuery({
      timeoutMs: MANAGER_SETTLE_TIMEOUT_MS,
      request: () => sendManagerQueryFromPage(page)
    });
    expect(second).toMatchObject({ ok: true });
  } finally {
    await page.close();
    await session.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(profilePath, { recursive: true, force: true })
    );
  }
});

test("parallel production runs keep isolated profiles and build paths", async () => {
  const runA = crypto.randomUUID();
  const runB = crypto.randomUUID();
  const worktree = process.cwd();
  const buildA = await buildExtension({
    worktreePath: worktree,
    runId: runA,
    graph: "production"
  });
  const buildB = await buildExtension({
    worktreePath: worktree,
    runId: runB,
    graph: "production"
  });
  expect(buildA.buildPath).not.toBe(buildB.buildPath);
  expect(resolveBuildOutput(worktree, runA, "production").buildPath).toBe(
    buildA.buildPath
  );
  expect(resolveBuildOutput(worktree, runB, "production").buildPath).toBe(
    buildB.buildPath
  );

  const profileA = path.join(profileRoot, `parallel-a-${crypto.randomUUID()}`);
  const profileB = path.join(profileRoot, `parallel-b-${crypto.randomUUID()}`);
  const sessionA = await launchExtensionSession({
    buildPath: buildA.buildPath,
    profilePath: profileA,
    headless: true
  });
  const sessionB = await launchExtensionSession({
    buildPath: buildB.buildPath,
    profilePath: profileB,
    headless: true
  });
  try {
    expect(profileA).not.toBe(profileB);
    expect(sessionA.extensionId).toMatch(/^[a-p]{32}$/);
    expect(sessionB.extensionId).toMatch(/^[a-p]{32}$/);
  } finally {
    await sessionA.close();
    await sessionB.close();
    const fs = await import("node:fs/promises");
    await fs.rm(profileA, { recursive: true, force: true });
    await fs.rm(profileB, { recursive: true, force: true });
  }
});
