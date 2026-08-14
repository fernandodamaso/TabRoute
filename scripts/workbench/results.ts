import path from "node:path";
import type {
  ArtifactKind,
  ArtifactLimitSource,
  CapacityFailure,
  CleanupFailure,
  LeaseRecord,
  ManagerTimeoutFailure,
  RestartFailure,
  RunAssertion,
  RunResult,
  RunResultSuccess,
  WorkerTimeoutFailure
} from "./contracts";
import { boundedError } from "./contracts";
import { createArtifactStore, encodeUtf8 } from "./artifacts";

export function formatRetainedResultPath(resultPath: string): string {
  return `Workbench result: ${path.resolve(resultPath)}`;
}

export function printRetainedResultPath(resultPath: string): void {
  process.stdout.write(`${formatRetainedResultPath(resultPath)}\n`);
}

export interface ResultWriter {
  write(result: RunResult): Promise<string>;
  writeArtifact(
    relativePath: string,
    bytes: Uint8Array,
    kind: ArtifactKind
  ): Promise<void>;
  appendLog(event: {
    source: string;
    name: string;
    details?: Record<string, string | number | boolean>;
  }): Promise<void>;
  finalize(status: "completed" | "failed" | "abandoned"): Promise<void>;
}

export function createResultWriter(
  artifactPath: string,
  runId: string
): ResultWriter {
  const store = createArtifactStore({ root: artifactPath, runId });
  const resultPath = path.join(artifactPath, "results.json");
  const logLines: string[] = [];
  return {
    async write(result) {
      await store.writeRequiredResult(
        result as ArtifactLimitSource & RunResult
      );
      return resultPath;
    },
    async writeArtifact(relativePath, bytes, kind) {
      await store.write(relativePath, bytes, kind);
    },
    async appendLog(event) {
      const details = event.details ? JSON.stringify(event.details) : "";
      logLines.push(
        `${new Date().toISOString()} ${event.source} ${event.name} ${details}`.trimEnd()
      );
      await store.write(
        "runner.log",
        encodeUtf8(`${logLines.join("\n")}\n`),
        "log"
      );
    },
    async finalize(status) {
      await store.finalize(status);
    }
  };
}

export function workerTimeoutFailure(
  metadata: Omit<
    WorkerTimeoutFailure,
    "ok" | "status" | "code" | "phase" | "error"
  >,
  message = "extension service worker was not discovered before the deadline"
): WorkerTimeoutFailure {
  return {
    ...metadata,
    ok: false,
    status: "failed",
    code: "WORKBENCH_WORKER_TIMEOUT",
    phase: "worker",
    error: boundedError({ message })
  };
}

export function managerTimeoutFailure(
  metadata: Omit<
    ManagerTimeoutFailure,
    "ok" | "status" | "code" | "phase" | "error"
  >,
  message = "first manager query did not settle before the deadline"
): ManagerTimeoutFailure {
  return {
    ...metadata,
    ok: false,
    status: "failed",
    code: "WORKBENCH_MANAGER_TIMEOUT",
    phase: "manager-query",
    error: boundedError({ message })
  };
}

export function restartFailure(
  metadata: Omit<RestartFailure, "ok" | "status" | "code" | "error" | "phase">,
  phase: "restart-termination" | "restart-wake"
): RestartFailure {
  return {
    ...metadata,
    ok: false,
    status: "failed",
    code: "WORKBENCH_WORKER_TIMEOUT",
    phase,
    error: boundedError({
      message:
        phase === "restart-termination"
          ? "extension service worker did not terminate before the deadline"
          : "extension service worker did not wake before the deadline"
    })
  };
}

export function cleanupFailure(
  metadata: Omit<CleanupFailure, "ok" | "status" | "code" | "phase" | "error">,
  errorMessage: string,
  retainedPath: string
): CleanupFailure {
  const result: CleanupFailure = {
    ...metadata,
    ok: false,
    status: "failed",
    code: "WORKBENCH_CLEANUP_FAILED",
    phase: "cleanup",
    cleanup: { profileRemoved: false, retainedPath },
    error: boundedError({ message: errorMessage })
  };
  if (metadata.extensionId !== undefined)
    result.extensionId = metadata.extensionId;
  return result;
}

export function argumentFailure(
  runId: string,
  worktreePath: string,
  message: string
): import("./contracts").ArgumentFailure {
  return {
    ok: false,
    status: "failed",
    code: "WORKBENCH_ARGUMENT",
    phase: "argument",
    runId,
    worktreePath,
    error: boundedError({ message })
  };
}

export function capacityFailure(
  runId: string,
  worktreePath: string,
  message: string
): CapacityFailure {
  return {
    ok: false,
    status: "failed",
    code: "WORKBENCH_CAPACITY",
    phase: "capacity",
    runId,
    worktreePath,
    error: boundedError({ message })
  };
}

export function successResult(
  metadata: Omit<RunResultSuccess, "ok" | "status">
): RunResultSuccess {
  return { ...metadata, ok: true, status: "completed" };
}

export function emptyStartedMetadata(input: {
  runId: string;
  worktreePath: string;
  buildPath: string;
  profilePath: string;
  mode: "fixture" | "real";
  url: string;
  scenario: string;
  route: RunResultSuccess["route"];
  deepLink: RunResultSuccess["deepLink"];
  lease: LeaseRecord;
}): Omit<RunResultSuccess, "ok" | "status" | "extensionId"> {
  return {
    ...input,
    commandRecords: [],
    readiness: {},
    screenshotPaths: [],
    assertions: [],
    cleanup: { profileRemoved: false }
  };
}

export function previewAssertion(
  passed: boolean,
  details?: RunAssertion["details"]
): RunAssertion {
  return {
    name: "workbench-preview-dimensions",
    passed,
    ...(details ? { details } : {})
  };
}
