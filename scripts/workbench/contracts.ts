import type { ManagerDeepLink, ManagerRoute, ManagerTransportRecord } from "../../src/ui/manager/types";

export type WorkbenchErrorCode =
  | "WORKBENCH_ARGUMENT"
  | "WORKBENCH_WORKER_TIMEOUT"
  | "WORKBENCH_MANAGER_TIMEOUT"
  | "WORKBENCH_CLEANUP_FAILED"
  | "WORKBENCH_CAPACITY"
  | "WORKBENCH_ARTIFACT_LIMIT";

export const REQUIRED_METADATA_RESERVATION_BYTES = 2 * 1024 * 1024;
export const REQUIRED_METADATA_CAPS = {
  maxCommandRecords: 1000,
  maxEventRecords: 1000,
  maxAssertions: 1000,
  maxScreenshotPaths: 500,
  maxStringBytes: 4096,
  maxUrlBytes: 16384,
  maxErrorBytes: 8192
} as const;

export interface RunPaths { runId: string; worktreePath: string; buildPath: string; profilePath: string; artifactPath: string; }
export type ArtifactKind = "log" | "screenshot" | "trace" | "video" | "result" | "error" | "lease" | "status";
export interface ArtifactStore { write(relativePath: string, bytes: Uint8Array, kind: ArtifactKind): Promise<void>; finalize(status: "completed" | "failed" | "abandoned"): Promise<void>; }
export interface LeaseRecord { runId: string; pid: number; startedAt: string; heartbeat: string; profilePath: string; status: "active" | "abandoned" | "completed"; }
export interface CrossProcessLock { acquire(): Promise<{ release(): Promise<void> }>; withLock<T>(operation: () => Promise<T>): Promise<T>; }

export interface BoundedRunError { message: string; details?: Readonly<Record<string, string | number | boolean>>; }
export type RunResultStatus = "completed" | "failed" | "abandoned";
export interface RunAssertion { name: string; passed: boolean; details?: Readonly<Record<string, string | number | boolean>>; }
export interface RunResultStartedMetadata {
  status: RunResultStatus; runId: string; worktreePath: string; buildPath: string; profilePath: string;
  mode: "fixture" | "real"; url: string; scenario: string; route: ManagerRoute; deepLink: ManagerDeepLink;
  commandRecords: readonly ManagerTransportRecord[]; readiness: { workerDiscoveredAt?: string; managerQuerySettledAt?: string };
  screenshotPaths: readonly string[]; assertions: readonly RunAssertion[]; lease: LeaseRecord;
  cleanup: { profileRemoved: boolean; retainedPath?: string };
}
export interface RunResultSuccess extends RunResultStartedMetadata { ok: true; status: "completed"; extensionId: string; code?: never; phase?: never; error?: never; }
export interface ArgumentFailure { ok: false; status: "failed"; code: "WORKBENCH_ARGUMENT"; phase: "argument"; runId: string; worktreePath: string; error: BoundedRunError; }
export interface CapacityFailure { ok: false; status: "failed"; code: "WORKBENCH_CAPACITY"; phase: "capacity"; runId: string; worktreePath: string; error: BoundedRunError; }
export interface WorkerTimeoutFailure extends RunResultStartedMetadata { ok: false; status: "failed"; code: "WORKBENCH_WORKER_TIMEOUT"; phase: "worker"; extensionId?: never; error: BoundedRunError; }
export interface ManagerTimeoutFailure extends RunResultStartedMetadata { ok: false; status: "failed"; code: "WORKBENCH_MANAGER_TIMEOUT"; phase: "manager-query"; extensionId: string; error: BoundedRunError; }
export interface RestartFailure extends RunResultStartedMetadata { ok: false; status: "failed"; code: "WORKBENCH_WORKER_TIMEOUT"; phase: "restart-termination" | "restart-wake"; extensionId: string; error: BoundedRunError; }
export interface CleanupFailure extends RunResultStartedMetadata { ok: false; status: "failed"; code: "WORKBENCH_CLEANUP_FAILED"; phase: "cleanup"; extensionId?: string; error: BoundedRunError; }
export interface ArtifactLimitFailure extends RunResultStartedMetadata { ok: false; status: "failed"; code: "WORKBENCH_ARTIFACT_LIMIT"; phase: "artifact"; extensionId?: string; error: BoundedRunError; }
export interface AbandonedRunMetadata extends Omit<RunResultStartedMetadata, "status" | "lease" | "cleanup"> { status: "abandoned"; extensionId?: string; lease: LeaseRecord & { status: "abandoned" }; cleanup: { profileRemoved: true; retainedPath?: never } | { profileRemoved: false; retainedPath: string }; }
export interface AbandonedRunResult extends AbandonedRunMetadata { ok: true; cleanup: { profileRemoved: true; retainedPath?: never }; code?: never; phase?: never; error?: never; }
export interface AbandonedCleanupFailure extends AbandonedRunMetadata { ok: false; code: "WORKBENCH_CLEANUP_FAILED"; phase: "cleanup"; cleanup: { profileRemoved: false; retainedPath: string }; error: BoundedRunError; }
export type RunStartedFailure = WorkerTimeoutFailure | ManagerTimeoutFailure | RestartFailure | CleanupFailure | ArtifactLimitFailure;
export type RunResultFailure = ArgumentFailure | CapacityFailure | RunStartedFailure | AbandonedCleanupFailure;
export type RunResult = RunResultSuccess | AbandonedRunResult | RunResultFailure;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function capUtf8(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  return bytes.byteLength <= maxBytes ? value : decoder.decode(bytes.slice(0, maxBytes));
}
export function boundedError(error: BoundedRunError): BoundedRunError {
  const details = error.details ? Object.fromEntries(Object.entries(error.details).slice(0, 32).map(([key, value]) => [capUtf8(key, 256), typeof value === "string" ? capUtf8(value, REQUIRED_METADATA_CAPS.maxErrorBytes) : value])) : undefined;
  return { message: capUtf8(error.message, REQUIRED_METADATA_CAPS.maxErrorBytes), ...(details && { details }) };
}
export function capRunMetadata<T extends Record<string, unknown>>(metadata: T): T {
  const capAny = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return capUtf8(value, key === "url" ? REQUIRED_METADATA_CAPS.maxUrlBytes : REQUIRED_METADATA_CAPS.maxStringBytes);
    if (Array.isArray(value)) return value.slice(0, key === "commandRecords" ? REQUIRED_METADATA_CAPS.maxCommandRecords : key === "assertions" ? REQUIRED_METADATA_CAPS.maxAssertions : key === "screenshotPaths" ? REQUIRED_METADATA_CAPS.maxScreenshotPaths : REQUIRED_METADATA_CAPS.maxEventRecords).map((item) => capAny(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, capAny(entryValue, entryKey)]));
    return value;
  };
  return capAny(metadata) as T;
}
export function createArtifactLimitFailure(metadata: RunResultStartedMetadata, error: BoundedRunError): ArtifactLimitFailure {
  const capped = capRunMetadata({ ...metadata, status: "failed" }) as RunResultStartedMetadata;
  return { ...capped, ok: false, status: "failed", code: "WORKBENCH_ARTIFACT_LIMIT", phase: "artifact", error: boundedError(error) };
}

export function validateRunResult(value: unknown): value is RunResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean" || typeof result.status !== "string") return false;
  if (result.ok && result.status === "completed") return typeof result.extensionId === "string";
  if (result.status === "abandoned") {
    if (!result.lease || (result.lease as Record<string, unknown>).status !== "abandoned") return false;
    const cleanup = result.cleanup as Record<string, unknown> | undefined;
    if (!cleanup || typeof cleanup.profileRemoved !== "boolean") return false;
    if (cleanup.profileRemoved === false && typeof cleanup.retainedPath !== "string") return false;
    if (result.ok) return cleanup.profileRemoved === true && !("error" in result);
    return result.code === "WORKBENCH_CLEANUP_FAILED" && result.phase === "cleanup" && typeof (result.error as Record<string, unknown> | undefined)?.message === "string";
  }
  if (result.status !== "failed" || result.ok !== false || typeof result.code !== "string" || typeof result.phase !== "string") return false;
  if (result.code === "WORKBENCH_ARGUMENT" || result.code === "WORKBENCH_CAPACITY") return !("extensionId" in result);
  if (result.code === "WORKBENCH_MANAGER_TIMEOUT" || (result.code === "WORKBENCH_WORKER_TIMEOUT" && (result.phase === "restart-termination" || result.phase === "restart-wake"))) return typeof result.extensionId === "string";
  if (result.code === "WORKBENCH_WORKER_TIMEOUT" && result.phase === "worker") return !("extensionId" in result);
  return (result.code === "WORKBENCH_CLEANUP_FAILED" && result.phase === "cleanup") || (result.code === "WORKBENCH_ARTIFACT_LIMIT" && result.phase === "artifact");
}
