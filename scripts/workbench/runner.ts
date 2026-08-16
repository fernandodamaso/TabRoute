import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import type { ManagerTransportRecord } from "../../src/ui/manager/types";
import type { CapacityFailure, LeaseRecord, RunResult } from "./contracts";
import { createArtifactLimitFailure } from "./contracts";
import { writeAtomic } from "./artifacts";
import { buildExtension, resolveBuildOutput } from "./build";
import {
  canonicalExtensionUrl,
  launchExtensionSession,
  sendManagerQueryFromPage,
  type ExtensionSession,
  type RunnerEvent
} from "./browser";
import {
  MANAGER_QUERY_TIMEOUT_MS,
  settleManagerQuery,
  WorkbenchCodedError
} from "./readiness";
import { LeaseManager } from "./leases";
import { assertOwnedProfilePath } from "./paths";
import {
  argumentFailure,
  cleanupFailure,
  createResultWriter,
  emptyStartedMetadata,
  managerTimeoutFailure,
  previewAssertion,
  printRetainedResultPath,
  restartFailure,
  successResult,
  workerTimeoutFailure
} from "./results";
import {
  type ProductionGateResult,
  scanProductionBuild,
  scanWorkbenchBuild,
  writeProductionGateResult
} from "./production-scan";

const CLEANUP_BACKOFF_MS = [250, 500, 1000] as const;

export interface RunCleanupInput {
  close: () => Promise<void>;
  profilePath: string;
  profileRoot: string;
  runId: string;
  worktreePath: string;
  remove?: (target: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function runCleanup(
  input: RunCleanupInput
): Promise<
  | { profileRemoved: true }
  | { profileRemoved: false; retainedPath: string; error: string }
> {
  const sleep =
    input.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const remove =
    input.remove ?? ((target) => rm(target, { recursive: true, force: true }));
  await input.close();
  const ownedProfile = assertOwnedProfilePath(
    input.profilePath,
    input.profileRoot,
    input.runId,
    input.worktreePath
  );
  let lastError: unknown;
  for (let attempt = 0; attempt <= CLEANUP_BACKOFF_MS.length; attempt += 1) {
    try {
      await remove(ownedProfile);
      return { profileRemoved: true };
    } catch (error) {
      lastError = error;
      if (attempt === CLEANUP_BACKOFF_MS.length) break;
      await sleep(CLEANUP_BACKOFF_MS[attempt]!);
    }
  }
  return {
    profileRemoved: false,
    retainedPath: ownedProfile,
    error:
      lastError instanceof Error ? lastError.message : "profile cleanup failed"
  };
}

export interface RunWorkbenchInput {
  worktreePath: string;
  mode: "fixture" | "real";
  entryPoint: string;
  scenario: string;
  once?: boolean;
  headless?: boolean;
}

function isCapacityFailure(
  value: LeaseRecord | CapacityFailure
): value is CapacityFailure {
  return "ok" in value && value.ok === false;
}

async function writeLease(
  artifactPath: string,
  lease: LeaseRecord,
  status: LeaseRecord["status"]
): Promise<void> {
  await writeAtomic(
    path.join(artifactPath, "lease.json"),
    new TextEncoder().encode(JSON.stringify({ ...lease, status }))
  );
}

function startedBase(input: {
  runId: string;
  worktreePath: string;
  buildPath: string;
  profilePath: string;
  mode: "fixture" | "real";
  url: string;
  scenario: string;
  lease: LeaseRecord;
}) {
  return emptyStartedMetadata({
    ...input,
    route: "groups",
    deepLink: "none"
  });
}

function generationRecords(
  mode: "fixture" | "real",
  generations: Array<{ id: string; discoveredAt: string }>
): ManagerTransportRecord[] {
  return generations.map((generation) => ({
    recordType: "event" as const,
    mode,
    source: "worker" as const,
    at: Date.parse(generation.discoveredAt) || Date.now(),
    name: "worker-generation",
    details: { id: generation.id, discoveredAt: generation.discoveredAt }
  }));
}

function eventRecord(
  mode: "fixture" | "real",
  event: RunnerEvent
): ManagerTransportRecord {
  const details: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event.details ?? {})) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      details[key] = value;
  }
  return {
    recordType: "event",
    mode,
    source: event.source === "browser" ? "page" : event.source,
    at: Date.now(),
    name: event.name,
    details
  };
}

function classifyFailure(
  base: ReturnType<typeof startedBase>,
  error: unknown,
  extensionId?: string
): RunResult {
  if (error instanceof WorkbenchCodedError) {
    if (error.code === "WORKBENCH_ARGUMENT")
      return argumentFailure(base.runId, base.worktreePath, error.message);
    if (error.code === "WORKBENCH_MANAGER_TIMEOUT") {
      return managerTimeoutFailure(
        { ...base, extensionId: extensionId!, readiness: base.readiness },
        error.message
      );
    }
    if (
      error.phase === "restart-termination" ||
      error.phase === "restart-wake"
    ) {
      return restartFailure(
        { ...base, extensionId: extensionId!, readiness: base.readiness },
        error.phase
      );
    }
    if (error.code === "WORKBENCH_WORKER_TIMEOUT")
      return workerTimeoutFailure(base, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith("WORKBENCH_ARGUMENT") ||
    message.includes("WORKBENCH_ARGUMENT")
  ) {
    return argumentFailure(base.runId, base.worktreePath, message);
  }
  if (message.includes("WORKBENCH_ARTIFACT_LIMIT")) {
    return argumentFailure(base.runId, base.worktreePath, message);
  }
  if (extensionId)
    return managerTimeoutFailure(
      { ...base, extensionId, readiness: base.readiness },
      message
    );
  return workerTimeoutFailure(base, message);
}

async function waitForPageQuerySettlement(page: Page): Promise<void> {
  await page.waitForSelector(
    '[data-workbench-status="manager-ready"], [data-workbench-status="manager-error"]',
    { timeout: MANAGER_QUERY_TIMEOUT_MS }
  );
}

async function settleFirstManagerQuery(
  page: Page,
  mode: "fixture" | "real"
): Promise<void> {
  if (mode === "real") {
    await settleManagerQuery({
      request: () => sendManagerQueryFromPage(page)
    });
  }
  await waitForPageQuerySettlement(page);
}

export async function runWorkbench(
  input: RunWorkbenchInput
): Promise<RunResult> {
  const worktreePath = path.resolve(input.worktreePath);
  const cwd = path.resolve(process.cwd());
  if (worktreePath !== cwd)
    throw new WorkbenchCodedError(
      "WORKBENCH_ARGUMENT",
      "worktree must match process.cwd()",
      "argument"
    );

  const runId = crypto.randomUUID();
  const profileRoot = path.join(os.tmpdir(), "tabroute-workbench");
  const profilePath = path.join(profileRoot, runId);
  const artifactPath = path.join(
    worktreePath,
    ".workbench",
    "artifacts",
    runId
  );
  const buildOutput = resolveBuildOutput(worktreePath, runId, "workbench");
  const pendingUrl = canonicalExtensionUrl(
    "pending",
    input.entryPoint,
    input.mode
  ).replace("pending", "{id}");
  const writer = createResultWriter(artifactPath, runId);
  const commandRecords: ManagerTransportRecord[] = [];
  let session: ExtensionSession | undefined;
  let heartbeat: { stop(): void } | undefined;
  let lease: LeaseRecord | undefined;

  const onEvent = async (event: RunnerEvent) => {
    commandRecords.push(eventRecord(input.mode, event));
    await writer.appendLog(event).catch(() => undefined);
  };

  const persistLease = async (status: LeaseRecord["status"]) => {
    if (!lease) return;
    await writeLease(artifactPath, lease, status);
  };

  const publish = async (
    result: RunResult,
    status: "completed" | "failed" | "abandoned"
  ): Promise<RunResult> => {
    const resultPath = await writer.write(result);
    await writer.finalize(status);
    printRetainedResultPath(resultPath);
    return result;
  };

  const finishWithCleanup = async (result: RunResult): Promise<RunResult> => {
    heartbeat?.stop();
    const cleanup = await runCleanup({
      close: () => session?.close() ?? Promise.resolve(),
      profilePath,
      profileRoot,
      runId,
      worktreePath
    }).catch(async () => {
      await session?.close().catch(() => undefined);
      return {
        profileRemoved: false as const,
        retainedPath: profilePath,
        error: "cleanup failed"
      };
    });
    const leaseStatus: LeaseRecord["status"] = cleanup.profileRemoved
      ? "completed"
      : "active";
    await persistLease(leaseStatus);
    if (
      !result.ok &&
      (result.phase === "argument" || result.phase === "capacity")
    ) {
      return publish(result, "failed");
    }
    if (!result.ok && result.phase === "artifact") {
      return publish(
        {
          ...result,
          cleanup: cleanup.profileRemoved
            ? { profileRemoved: true as const }
            : {
                profileRemoved: false as const,
                retainedPath: cleanup.retainedPath
              }
        },
        "failed"
      );
    }
    if (cleanup.profileRemoved) {
      const nextLease = { ...lease!, status: "completed" as const };
      return publish(
        {
          ...result,
          lease: nextLease,
          cleanup: { profileRemoved: true as const }
        } as RunResult,
        result.ok ? "completed" : "failed"
      );
    }
    return publish(
      cleanupFailure(
        {
          ...result,
          lease: { ...lease!, status: "active" },
          cleanup: { profileRemoved: false }
        },
        cleanup.error,
        cleanup.retainedPath
      ),
      "failed"
    );
  };

  try {
    const leaseManager = new LeaseManager({
      artifactRoot: path.join(worktreePath, ".workbench", "artifacts"),
      worktreePath,
      profileRoot
    });
    await leaseManager.reapOrphans();
    const leaseResult = await leaseManager.createLease({
      runId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeat: new Date().toISOString(),
      profilePath
    });
    if (isCapacityFailure(leaseResult)) {
      await rm(profilePath, { recursive: true, force: true }).catch(
        () => undefined
      );
      return publish(leaseResult, "failed");
    }
    lease = leaseResult;
    heartbeat = leaseManager.startHeartbeat(runId);
    await mkdir(profilePath, { recursive: true });

    try {
      await buildExtension({ worktreePath, runId, graph: "workbench" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await finishWithCleanup(
        argumentFailure(runId, worktreePath, message)
      );
    }

    session = await launchExtensionSession({
      buildPath: buildOutput.buildPath,
      profilePath,
      headless: input.headless ?? false,
      onEvent
    });
    const workerDiscoveredAt = new Date().toISOString();
    const extensionId = session.extensionId;
    const canonicalUrl = canonicalExtensionUrl(
      extensionId,
      input.entryPoint,
      input.mode
    );
    commandRecords.push(
      ...generationRecords(input.mode, session.workerGenerations)
    );
    const base = {
      ...startedBase({
        runId,
        worktreePath,
        buildPath: buildOutput.buildPath,
        profilePath,
        mode: input.mode,
        url: canonicalUrl,
        scenario: input.scenario,
        lease
      }),
      commandRecords,
      readiness: { workerDiscoveredAt }
    };

    const page = await session.context.newPage();
    await page.goto(canonicalUrl);

    try {
      await settleFirstManagerQuery(page, input.mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await finishWithCleanup(
        managerTimeoutFailure({ ...base, extensionId }, message)
      );
    }

    const managerQuerySettledAt = new Date().toISOString();
    const preview = page.locator(".workbench-preview");
    await preview.waitFor({
      state: "visible",
      timeout: MANAGER_QUERY_TIMEOUT_MS
    });
    const box = await preview.evaluate((element) => {
      const computed = window.getComputedStyle(element);
      return {
        width: Number.parseFloat(computed.width),
        height: Number.parseFloat(computed.height)
      };
    });
    const dimensionsOk = box.width === 520 && box.height === 600;
    const screenshotRelative = "screenshots/workbench-preview.png";
    const screenshotBytes = await preview.screenshot({ type: "png" });
    try {
      await writer.writeArtifact(
        screenshotRelative,
        screenshotBytes,
        "screenshot"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await finishWithCleanup(
        createArtifactLimitFailure(
          {
            runId,
            worktreePath,
            buildPath: buildOutput.buildPath,
            profilePath,
            lease: { ...lease, status: "active" },
            cleanup: { profileRemoved: false, retainedPath: profilePath },
            extensionId
          },
          { message }
        )
      );
    }

    const success = successResult({
      ...base,
      extensionId,
      readiness: { workerDiscoveredAt, managerQuerySettledAt },
      screenshotPaths: [screenshotRelative],
      assertions: [
        previewAssertion(dimensionsOk, { width: box.width, height: box.height })
      ],
      cleanup: { profileRemoved: false }
    });

    if (input.once) {
      await page.close();
      return await finishWithCleanup(success);
    }

    await publish(success, "completed");
    await page.close();
    await new Promise<void>((resolve) => {
      session!.context.on("close", () => resolve());
    });
    return await finishWithCleanup(success);
  } catch (error) {
    if (!lease) {
      return publish(
        argumentFailure(
          runId,
          worktreePath,
          error instanceof Error ? error.message : String(error)
        ),
        "failed"
      );
    }
    const base = {
      ...startedBase({
        runId,
        worktreePath,
        buildPath: buildOutput.buildPath,
        profilePath,
        mode: input.mode,
        url: session
          ? canonicalExtensionUrl(
              session.extensionId,
              input.entryPoint,
              input.mode
            )
          : pendingUrl,
        scenario: input.scenario,
        lease
      }),
      commandRecords,
      readiness: session ? { workerDiscoveredAt: new Date().toISOString() } : {}
    };
    return await finishWithCleanup(
      classifyFailure(base, error, session?.extensionId)
    );
  }
}

export async function runProductionGate(
  worktreePath: string
): Promise<ProductionGateResult> {
  const resolved = path.resolve(worktreePath);
  const cwd = path.resolve(process.cwd());
  if (resolved !== cwd)
    throw new WorkbenchCodedError(
      "WORKBENCH_ARGUMENT",
      "worktree must match process.cwd()",
      "argument"
    );

  const runId = crypto.randomUUID();
  const workbenchBuild = await buildExtension({
    worktreePath: resolved,
    runId,
    graph: "workbench"
  });
  const workbenchScan = await scanWorkbenchBuild(workbenchBuild.buildPath);
  if (!workbenchScan.ok) {
    throw new WorkbenchCodedError(
      "WORKBENCH_ARGUMENT",
      workbenchScan.errors.join("; "),
      "argument"
    );
  }

  const productionBuild = await buildExtension({
    worktreePath: resolved,
    runId,
    graph: "production",
    productionE2e: true
  });
  const productionScan = await scanProductionBuild(productionBuild.buildPath);
  if (!productionScan.ok) {
    throw new WorkbenchCodedError(
      "WORKBENCH_ARGUMENT",
      productionScan.errors.join("; "),
      "argument"
    );
  }

  const resultPath = await writeProductionGateResult(resolved, runId, {
    graph: "production",
    workbenchBuildPath: workbenchBuild.buildPath,
    productionBuildPath: productionBuild.buildPath,
    productionScan: { ok: true }
  });
  const result: ProductionGateResult = {
    graph: "production",
    resultPath,
    workbenchBuildPath: workbenchBuild.buildPath,
    productionBuildPath: productionBuild.buildPath,
    productionScan: { ok: true }
  };
  printRetainedResultPath(resultPath);
  return result;
}
