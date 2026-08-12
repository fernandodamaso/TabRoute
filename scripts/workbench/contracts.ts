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
export interface ArtifactStore { write(relativePath: string, bytes: Uint8Array, kind: ArtifactKind, options?: { capturedAt?: number }): Promise<void>; finalize(status: "completed" | "failed" | "abandoned"): Promise<void>; }
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
  if (bytes.byteLength <= maxBytes) return value;
  let result = decoder.decode(bytes.slice(0, maxBytes));
  while (encoder.encode(result).byteLength > maxBytes) result = result.slice(0, -1);
  return result;
}
export function boundedError(error: BoundedRunError): BoundedRunError {
  const details = error.details ? Object.fromEntries(Object.entries(error.details).slice(0, 32).map(([key, value]) => [capUtf8(key, 256), typeof value === "string" ? capUtf8(value, REQUIRED_METADATA_CAPS.maxErrorBytes) : value])) : undefined;
  return { message: capUtf8(error.message, REQUIRED_METADATA_CAPS.maxErrorBytes), ...(details && { details }) };
}
export function capRunMetadata<T extends Record<string, unknown>>(metadata: T): T {
  const capAny = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return capUtf8(value, key === "url" ? REQUIRED_METADATA_CAPS.maxUrlBytes : REQUIRED_METADATA_CAPS.maxStringBytes);
    if (Array.isArray(value)) return value.slice(0, key === "commandRecords" ? REQUIRED_METADATA_CAPS.maxCommandRecords : key === "assertions" ? REQUIRED_METADATA_CAPS.maxAssertions : key === "screenshotPaths" ? REQUIRED_METADATA_CAPS.maxScreenshotPaths : REQUIRED_METADATA_CAPS.maxEventRecords).map((item) => capAny(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, REQUIRED_METADATA_CAPS.maxEventRecords).map(([entryKey, entryValue]) => [capUtf8(entryKey, REQUIRED_METADATA_CAPS.maxStringBytes), capAny(entryValue, entryKey)]));
    return value;
  };
  return capAny(metadata) as T;
}
export function createArtifactLimitFailure(metadata: RunResultStartedMetadata, error: BoundedRunError): ArtifactLimitFailure {
  const safe = (value: unknown) => capUtf8(typeof value === "string" ? value : "", REQUIRED_METADATA_CAPS.maxStringBytes);
  const sourceLease = metadata.lease && typeof metadata.lease === "object" ? metadata.lease : { runId: "", pid: 0, startedAt: "", heartbeat: "", profilePath: "", status: "active" as const };
  const minimal = {
    ok: false as const,
    status: "failed" as const,
    code: "WORKBENCH_ARTIFACT_LIMIT" as const,
    phase: "artifact" as const,
    runId: safe(metadata.runId),
    worktreePath: safe(metadata.worktreePath),
    buildPath: safe(metadata.buildPath),
    profilePath: safe(metadata.profilePath),
    lease: { ...sourceLease, runId: safe(sourceLease.runId), profilePath: safe(sourceLease.profilePath) },
    cleanup: metadata.cleanup?.profileRemoved ? { profileRemoved: true as const } : { profileRemoved: false as const, retainedPath: safe(metadata.cleanup?.retainedPath ?? metadata.profilePath) },
    error: boundedError(error)
  };
  if (typeof (metadata as Partial<RunResultStartedMetadata & { extensionId?: unknown }>).extensionId === "string") return { ...minimal, extensionId: safe((metadata as unknown as { extensionId: string }).extensionId) } as ArtifactLimitFailure;
  return minimal as ArtifactLimitFailure;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function validString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function validBoundedError(value: unknown): value is BoundedRunError {
  if (!value || typeof value !== "object" || !validString((value as Record<string, unknown>).message)) return false;
  const details = (value as Record<string, unknown>).details;
  return details === undefined || (details !== null && typeof details === "object" && Object.values(details as Record<string, unknown>).every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean"));
}
function validLease(value: unknown, status?: LeaseRecord["status"]): value is LeaseRecord {
  if (!value || typeof value !== "object") return false;
  const lease = value as Record<string, unknown>;
  return validString(lease.runId) && typeof lease.pid === "number" && Number.isInteger(lease.pid) && validString(lease.startedAt) && validString(lease.heartbeat) && validString(lease.profilePath) && (lease.status === (status ?? lease.status)) && (status ? lease.status === status : lease.status === "active" || lease.status === "completed");
}
export function validateStartedMetadata(value: unknown): value is RunResultStartedMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!validString(item.runId) || !validString(item.worktreePath) || !validString(item.buildPath) || !validString(item.profilePath) || (item.mode !== "fixture" && item.mode !== "real") || !validString(item.url) || !validString(item.scenario)) return false;
  const deepLink = item.deepLink;
  const validDeepLink = deepLink === "none" || deepLink === "new-rule" || (deepLink && typeof deepLink === "object" && ["edit-rule", "confirm-delete"].includes((deepLink as Record<string, unknown>).kind as string) && validString((deepLink as Record<string, unknown>).ruleId));
  if (!["groups", "rules", "activity", "settings"].includes(item.route as string) || !validDeepLink) return false;
  if (!Array.isArray(item.commandRecords) || !item.readiness || typeof item.readiness !== "object" || !Array.isArray(item.screenshotPaths) || !Array.isArray(item.assertions) || !validLease(item.lease) || !item.cleanup || typeof item.cleanup !== "object") return false;
  const cleanup = item.cleanup as Record<string, unknown>;
  return typeof cleanup.profileRemoved === "boolean" && (!('retainedPath' in cleanup) || validString(cleanup.retainedPath));
}

export function validateRunResult(value: unknown): value is RunResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean" || typeof result.status !== "string") return false;
  if (result.ok && result.status === "completed") return validateStartedMetadata(result) && typeof result.extensionId === "string" && hasOnlyKeys(result, ["ok", "status", "runId", "worktreePath", "buildPath", "profilePath", "mode", "url", "scenario", "route", "deepLink", "commandRecords", "readiness", "screenshotPaths", "assertions", "lease", "cleanup", "extensionId"]);
  if (result.status === "abandoned") {
    if (!validateStartedMetadata({ ...result, status: "failed", lease: result.lease && { ...(result.lease as object), status: "active" } })) return false;
    if (!result.lease || !validLease(result.lease, "abandoned")) return false;
    const cleanup = result.cleanup as Record<string, unknown> | undefined;
    if (!cleanup || typeof cleanup.profileRemoved !== "boolean") return false;
    if (cleanup.profileRemoved === false && typeof cleanup.retainedPath !== "string") return false;
    if (cleanup.profileRemoved === true && "retainedPath" in cleanup) return false;
    if (result.ok) return cleanup.profileRemoved === true && hasOnlyKeys(result, ["ok", "status", "runId", "worktreePath", "buildPath", "profilePath", "mode", "url", "scenario", "route", "deepLink", "commandRecords", "readiness", "screenshotPaths", "assertions", "lease", "cleanup", "extensionId"]);
    return result.code === "WORKBENCH_CLEANUP_FAILED" && result.phase === "cleanup" && validBoundedError(result.error) && hasOnlyKeys(result, ["ok", "status", "code", "phase", "runId", "worktreePath", "buildPath", "profilePath", "mode", "url", "scenario", "route", "deepLink", "commandRecords", "readiness", "screenshotPaths", "assertions", "lease", "cleanup", "extensionId", "error"]);
  }
  if (result.status !== "failed" || result.ok !== false || typeof result.code !== "string" || typeof result.phase !== "string") return false;
  if (result.code === "WORKBENCH_ARGUMENT" || result.code === "WORKBENCH_CAPACITY") return !("extensionId" in result) && result.phase === (result.code === "WORKBENCH_ARGUMENT" ? "argument" : "capacity") && typeof result.runId === "string" && typeof result.worktreePath === "string" && validBoundedError(result.error) && hasOnlyKeys(result, ["ok", "status", "code", "phase", "runId", "worktreePath", "error"]);
  if (result.code === "WORKBENCH_ARTIFACT_LIMIT" && result.phase === "artifact" && validBoundedError(result.error) && typeof result.runId === "string" && validLease(result.lease, "active") && typeof result.buildPath === "string" && typeof result.profilePath === "string" && result.cleanup && typeof result.cleanup === "object") {
    return hasOnlyKeys(result, ["ok", "status", "code", "phase", "runId", "worktreePath", "buildPath", "profilePath", "lease", "cleanup", "error", "extensionId"]);
  }
  if (!validateStartedMetadata(result) || !validBoundedError(result.error)) return false;
  const startedKeys = ["ok", "status", "code", "phase", "runId", "worktreePath", "buildPath", "profilePath", "mode", "url", "scenario", "route", "deepLink", "commandRecords", "readiness", "screenshotPaths", "assertions", "lease", "cleanup", "extensionId", "error"];
  if (!hasOnlyKeys(result, startedKeys)) return false;
  if (result.code === "WORKBENCH_MANAGER_TIMEOUT") return result.phase === "manager-query" && typeof result.extensionId === "string";
  if (result.code === "WORKBENCH_WORKER_TIMEOUT") return (result.phase === "worker" && !("extensionId" in result)) || ((result.phase === "restart-termination" || result.phase === "restart-wake") && typeof result.extensionId === "string");
  return (result.code === "WORKBENCH_CLEANUP_FAILED" && result.phase === "cleanup" && (!('extensionId' in result) || typeof result.extensionId === "string")) || (result.code === "WORKBENCH_ARTIFACT_LIMIT" && result.phase === "artifact" && (!('extensionId' in result) || typeof result.extensionId === "string"));
}
