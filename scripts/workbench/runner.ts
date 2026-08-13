import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CapacityFailure, LeaseRecord, RunResult, RunStartedFailure } from "./contracts";
import { writeAtomic } from "./artifacts";
import { buildExtension, resolveBuildOutput } from "./build";
import {
  canonicalExtensionUrl,
  launchExtensionSession,
  type ExtensionSession
} from "./browser";
import { MANAGER_QUERY_TIMEOUT_MS } from "./readiness";
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

export async function runCleanup(input: RunCleanupInput): Promise<{ profileRemoved: true } | { profileRemoved: false; retainedPath: string; error: string }> {
  const sleep = input.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const remove = input.remove ?? ((target) => rm(target, { recursive: true, force: true }));
  await input.close();
  const ownedProfile = assertOwnedProfilePath(input.profilePath, input.profileRoot, input.runId, input.worktreePath);
  let lastError: unknown;
  for (let attempt = 0; attempt <= CLEANUP_BACKOFF_MS.length; attempt += 1) {
    try {
      await remove(ownedProfile);
      return { profileRemoved: true };
    } catch (error) {
      lastError = error;
      if (attempt === CLEANUP_BACKOFF_MS.length) break;
      await sleep(CLEANUP_BACKOFF_MS[attempt]);
    }
  }
  return {
    profileRemoved: false,
    retainedPath: ownedProfile,
    error: lastError instanceof Error ? lastError.message : "profile cleanup failed"
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

function isCapacityFailure(value: LeaseRecord | CapacityFailure): value is CapacityFailure {
  return "ok" in value && value.ok === false;
}

async function completeLease(artifactPath: string, lease: LeaseRecord): Promise<void> {
  await writeAtomic(path.join(artifactPath, "lease.json"), new TextEncoder().encode(JSON.stringify({ ...lease, status: "completed" })));
}

async function waitForManagerReady(page: ExtensionSession["context"]["pages"][number], timeoutMs = MANAGER_QUERY_TIMEOUT_MS): Promise<void> {
  await page.waitForSelector('[data-workbench-status="manager-ready"]', { timeout: timeoutMs });
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

function classifyStartedFailure(
  base: ReturnType<typeof startedBase>,
  message: string,
  extensionId?: string
): RunStartedFailure {
  if (message.includes("restart-termination")) {
    return restartFailure({ ...base, extensionId: extensionId!, readiness: {} }, "restart-termination");
  }
  if (message.includes("restart-wake")) {
    return restartFailure({ ...base, extensionId: extensionId!, readiness: {} }, "restart-wake");
  }
  if (message.includes("WORKBENCH_MANAGER_TIMEOUT") || message.includes("manager-ready")) {
    return managerTimeoutFailure({
      ...base,
      extensionId: extensionId!,
      readiness: {}
    });
  }
  return workerTimeoutFailure(base);
}

export async function runWorkbench(input: RunWorkbenchInput): Promise<RunResult> {
  const worktreePath = path.resolve(input.worktreePath);
  const cwd = path.resolve(process.cwd());
  if (worktreePath !== cwd) throw new Error("WORKBENCH_ARGUMENT: worktree must match process.cwd()");

  const runId = crypto.randomUUID();
  const profileRoot = path.join(os.tmpdir(), "tabroute-workbench");
  const profilePath = path.join(profileRoot, runId);
  const artifactPath = path.join(worktreePath, ".workbench", "artifacts", runId);
  const buildOutput = resolveBuildOutput(worktreePath, runId, "workbench");
  const pendingUrl = canonicalExtensionUrl("pending", input.entryPoint, input.mode).replace("pending", "{id}");
  const writer = createResultWriter(artifactPath, runId);
  let session: ExtensionSession | undefined;
  let heartbeat: { stop(): void } | undefined;
  let lease: LeaseRecord | undefined;

  const finalizeFailure = async (result: RunResult): Promise<RunResult> => {
    if (lease) await completeLease(artifactPath, lease);
    else {
      await writeAtomic(path.join(artifactPath, "lease.json"), new TextEncoder().encode(JSON.stringify({
        runId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        heartbeat: new Date().toISOString(),
        profilePath,
        status: "completed"
      } satisfies LeaseRecord)));
    }
    const resultPath = await writer.write(result);
    await writer.finalize("failed");
    printRetainedResultPath(resultPath);
    return result;
  };

  const shutdown = async (failure: RunStartedFailure | RunResult, extensionId?: string) => {
    heartbeat?.stop();
    const cleanup = await runCleanup({
      close: () => session?.close() ?? Promise.resolve(),
      profilePath,
      profileRoot,
      runId,
      worktreePath
    });
    const withCleanup = cleanup.profileRemoved
      ? { ...failure, cleanup: { profileRemoved: true as const } }
      : cleanupFailure(
        { ...failure, cleanup: { profileRemoved: false } },
        cleanup.error,
        cleanup.retainedPath
      );
    if (lease) await completeLease(artifactPath, lease);
    const resultPath = await writer.write(withCleanup);
    await writer.finalize("failed");
    printRetainedResultPath(resultPath);
    return withCleanup;
  };

  try {
    await mkdir(profilePath, { recursive: true });

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
    if (isCapacityFailure(leaseResult)) return await finalizeFailure(leaseResult);
    lease = leaseResult;
    heartbeat = leaseManager.startHeartbeat(runId);

    await buildExtension({ worktreePath, runId, graph: "workbench" });

    session = await launchExtensionSession({
      buildPath: buildOutput.buildPath,
      profilePath,
      headless: input.headless ?? false
    });
    const workerDiscoveredAt = new Date().toISOString();
    const extensionId = session.extensionId;
    const canonicalUrl = canonicalExtensionUrl(extensionId, input.entryPoint, input.mode);
    const base = startedBase({
      runId,
      worktreePath,
      buildPath: buildOutput.buildPath,
      profilePath,
      mode: input.mode,
      url: canonicalUrl,
      scenario: input.scenario,
      lease
    });

    const page = await session.context.newPage();
    await page.goto(canonicalUrl);

    try {
      await waitForManagerReady(page);
    } catch {
      return await shutdown(managerTimeoutFailure({
        ...base,
        extensionId,
        readiness: { workerDiscoveredAt }
      }), extensionId);
    }

    const managerQuerySettledAt = new Date().toISOString();
    const preview = page.locator(".workbench-preview");
    await preview.waitFor({ state: "visible", timeout: MANAGER_QUERY_TIMEOUT_MS });
    const box = await preview.evaluate((element) => {
      const computed = window.getComputedStyle(element);
      return {
        width: Number.parseFloat(computed.width),
        height: Number.parseFloat(computed.height)
      };
    });
    const dimensionsOk = box.width === 520 && box.height === 600;
    const screenshotRelative = "screenshots/workbench-preview.png";
    await mkdir(path.join(artifactPath, path.dirname(screenshotRelative)), { recursive: true });
    await preview.screenshot({ path: path.join(artifactPath, screenshotRelative) });

    const success = successResult({
      ...base,
      extensionId,
      readiness: { workerDiscoveredAt, managerQuerySettledAt },
      screenshotPaths: [screenshotRelative],
      assertions: [previewAssertion(dimensionsOk, { width: box.width, height: box.height })],
      cleanup: { profileRemoved: false }
    });

    if (input.once) {
      heartbeat.stop();
      await page.close();
      const cleanup = await runCleanup({ close: () => session!.close(), profilePath, profileRoot, runId, worktreePath });
      const finalized = cleanup.profileRemoved
        ? { ...success, cleanup: { profileRemoved: true as const } }
        : cleanupFailure({ ...success, cleanup: { profileRemoved: false } }, cleanup.error, cleanup.retainedPath);
      await completeLease(artifactPath, lease);
      const resultPath = await writer.write(finalized);
      await writer.finalize(finalized.ok ? "completed" : "failed");
      printRetainedResultPath(resultPath);
      return finalized;
    }

    const resultPath = await writer.write(success);
    await writer.finalize("completed");
    printRetainedResultPath(resultPath);
    await page.close();
    await new Promise<void>((resolve) => {
      session!.context.on("close", () => resolve());
    });
    heartbeat.stop();
    const cleanup = await runCleanup({ close: () => session!.close(), profilePath, profileRoot, runId, worktreePath });
    const finalized = cleanup.profileRemoved
      ? { ...success, cleanup: { profileRemoved: true as const } }
      : cleanupFailure({ ...success, cleanup: { profileRemoved: false } }, cleanup.error, cleanup.retainedPath);
    await completeLease(artifactPath, lease);
    const finalPath = await writer.write(finalized);
    await writer.finalize(finalized.ok ? "completed" : "failed");
    printRetainedResultPath(finalPath);
    return finalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("WORKBENCH_ARGUMENT") && !lease) {
      return await finalizeFailure(argumentFailure(runId, worktreePath, message));
    }
    if (message.includes("WORKBENCH_ARGUMENT") && lease) {
      heartbeat?.stop();
      const cleanup = await runCleanup({
        close: () => session?.close() ?? Promise.resolve(),
        profilePath,
        profileRoot,
        runId,
        worktreePath
      });
      await completeLease(artifactPath, lease);
      return await finalizeFailure(argumentFailure(runId, worktreePath, message));
    }
    if (!lease) {
      return await finalizeFailure(argumentFailure(runId, worktreePath, message));
    }
    const base = startedBase({
      runId,
      worktreePath,
      buildPath: buildOutput.buildPath,
      profilePath,
      mode: input.mode,
      url: pendingUrl,
      scenario: input.scenario,
      lease
    });
    const failure = classifyStartedFailure(base, message, session?.extensionId);
    if (failure.phase === "worker" && failure.readiness.workerDiscoveredAt === undefined && session) {
      failure.readiness = { workerDiscoveredAt: new Date().toISOString() };
    }
    return await shutdown(failure, session?.extensionId);
  }
}
