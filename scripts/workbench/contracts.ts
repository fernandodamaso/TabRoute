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
/** The overflow record is deliberately minimal: it is written when the full
 * started-run metadata cannot fit in the reserved required-metadata space. */
export interface ArtifactLimitFailure {
  ok: false;
  status: "failed";
  code: "WORKBENCH_ARTIFACT_LIMIT";
  phase: "artifact";
  runId: string;
  worktreePath: string;
  buildPath: string;
  profilePath: string;
  lease: LeaseRecord;
  cleanup: { profileRemoved: true; retainedPath?: never } | { profileRemoved: false; retainedPath: string };
  extensionId?: string;
  error: BoundedRunError;
}
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
  if (typeof (metadata as Partial<RunResultStartedMetadata & { extensionId?: unknown }>).extensionId === "string") return { ...minimal, extensionId: safe((metadata as unknown as { extensionId: string }).extensionId) };
  return minimal;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function validString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function validRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validBoundedError(value: unknown): value is BoundedRunError {
  if (!value || typeof value !== "object" || !validString((value as Record<string, unknown>).message)) return false;
  if (!hasOnlyKeys(value as Record<string, unknown>, ["message", "details"])) return false;
  const details = (value as Record<string, unknown>).details;
  return details === undefined || (details !== null && typeof details === "object" && Object.keys(details as Record<string, unknown>).every(validString) && Object.values(details as Record<string, unknown>).every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean"));
}
function validDetails(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean"));
}
function validFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
const managerRoutes = ["groups", "rules", "activity", "settings"] as const;
const groupColors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
function validCondition(value: unknown): boolean {
  if (!validRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "all" || value.kind === "any") return hasOnlyKeys(value, ["kind", "children"]) && Array.isArray(value.children) && value.children.every(validCondition);
  if (value.kind === "pinned") return hasOnlyKeys(value, ["kind", "value"]) && typeof value.value === "boolean";
  if (value.kind === "currentGroup") {
    if (!validRecord(value.placement) || typeof value.placement.kind !== "string") return false;
    if (value.placement.kind === "managed") return hasOnlyKeys(value.placement, ["kind", "managedGroupId"]) && validString(value.placement.managedGroupId);
    return (value.placement.kind === "unmanaged" || value.placement.kind === "ungrouped") && hasOnlyKeys(value.placement, ["kind"]);
  }
  const operators: Record<string, readonly string[]> = { url: ["exact", "pattern", "regex"], host: ["exact", "suffix"], path: ["exact", "prefix"], title: ["contains", "exact", "regex"], openerUrl: ["exact", "pattern", "suffix"], openerHost: ["exact", "pattern", "suffix"] };
  const allowedOperators = operators[value.kind];
  return allowedOperators !== undefined && hasOnlyKeys(value, ["kind", "operator", "value"]) && typeof value.operator === "string" && allowedOperators.includes(value.operator) && validString(value.value);
}
function validRule(value: unknown, draft = false): boolean {
  if (!validRecord(value) || value.schemaVersion !== 1 || !validString(value.targetGroupId) || typeof value.priority !== "number" || !Number.isInteger(value.priority) || !validCondition(value.positive) || !Array.isArray(value.negative) || !value.negative.every(validCondition) || !Array.isArray(value.actions) || !value.actions.every(validAction) || typeof value.enabled !== "boolean") return false;
  if (!hasOnlyKeys(value, ["schemaVersion", "id", "targetGroupId", "priority", "positive", "negative", "actions", "duplicatePolicy", "enabled", "pausedUntil", "createdAt", "updatedAt"])) return false;
  if (value.id !== undefined && !validString(value.id)) return false;
  if (!draft && !validString(value.id)) return false;
  if (value.createdAt !== undefined && !validFiniteNumber(value.createdAt)) return false;
  if (value.updatedAt !== undefined && !validFiniteNumber(value.updatedAt)) return false;
  if (!draft && (!validFiniteNumber(value.createdAt) || !validFiniteNumber(value.updatedAt))) return false;
  if (value.pausedUntil !== undefined && !validFiniteNumber(value.pausedUntil) && value.pausedUntil !== "restart") return false;
  return value.duplicatePolicy === undefined || validDuplicatePolicy(value.duplicatePolicy);
}
function validDuplicatePolicy(value: unknown): boolean {
  if (!validRecord(value) || typeof value.kind !== "string") return false;
  if (["allow", "exactUrl", "fragmentlessUrl", "domain", "urlAndTitle"].includes(value.kind)) return hasOnlyKeys(value, ["kind"]);
  return value.kind === "pattern" && hasOnlyKeys(value, ["kind", "pattern"]) && validString(value.pattern);
}
function validAction(value: unknown): boolean {
  if (!validRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "group" || value.kind === "ungroup" || value.kind === "makePersistent") return hasOnlyKeys(value, ["kind"]);
  if (value.kind === "setCollapsed") return hasOnlyKeys(value, ["kind", "collapsed"]) && typeof value.collapsed === "boolean";
  return value.kind === "setDuplicatePolicy" && hasOnlyKeys(value, ["kind", "policy"]) && validDuplicatePolicy(value.policy);
}
function validManagedGroup(value: unknown): boolean {
  return validRecord(value) && value.schemaVersion === 1 && validString(value.id) && validString(value.name) && (value.emoji === undefined || typeof value.emoji === "string") && groupColors.includes(value.color as typeof groupColors[number]) && typeof value.isFallback === "boolean" && typeof value.enabled === "boolean" && typeof value.isPersistent === "boolean" && validFiniteNumber(value.defaultOrder) && Number.isInteger(value.defaultOrder) && typeof value.defaultCollapsed === "boolean" && validFiniteNumber(value.createdAt) && validFiniteNumber(value.updatedAt) && (value.pausedUntil === undefined || validFiniteNumber(value.pausedUntil) || value.pausedUntil === "restart") && hasOnlyKeys(value, ["schemaVersion", "id", "name", "emoji", "color", "isFallback", "enabled", "isPersistent", "defaultOrder", "defaultCollapsed", "pausedUntil", "createdAt", "updatedAt"]);
}
function validConfiguration(value: unknown): boolean {
  if (!validRecord(value) || value.schemaVersion !== 1 || !validString(value.fallbackGroupId) || typeof value.automationEnabled !== "boolean" || !Array.isArray(value.groups) || !value.groups.every(validManagedGroup) || !Array.isArray(value.rules) || !value.rules.every((rule) => validRule(rule)) || !Array.isArray(value.persistentTabs) || value.persistentTabs.length !== 0 || !Array.isArray(value.templates) || value.templates.length !== 0 || !validRecord(value.duplicateSettings) || !hasOnlyKeys(value.duplicateSettings, ["globalPolicy", "globalExclusions", "trackingParameters"]) || !validRecord(value.duplicateSettings.globalPolicy) || value.duplicateSettings.globalPolicy.kind !== "allow" || !hasOnlyKeys(value.duplicateSettings.globalPolicy, ["kind"]) || !Array.isArray(value.duplicateSettings.globalExclusions) || !value.duplicateSettings.globalExclusions.every(validString) || !Array.isArray(value.duplicateSettings.trackingParameters) || !value.duplicateSettings.trackingParameters.every(validString) || !validFiniteNumber(value.snapshotIntervalMinutes) || value.activityLimit !== 500 || value.snapshotLimit !== 50 || value.undoTtlMs !== 30000 || !validFiniteNumber(value.createdAt) || !validFiniteNumber(value.updatedAt)) return false;
  return hasOnlyKeys(value, ["schemaVersion", "fallbackGroupId", "automationEnabled", "globalPausedUntil", "groups", "rules", "persistentTabs", "duplicateSettings", "templates", "snapshotIntervalMinutes", "activityLimit", "snapshotLimit", "undoTtlMs", "createdAt", "updatedAt"]) && (value.globalPausedUntil === undefined || validFiniteNumber(value.globalPausedUntil) || value.globalPausedUntil === "restart");
}
function validView(value: unknown): boolean {
  return validRecord(value) && value.width === 520 && value.height === 600 && value.headerHeight === 52 && value.navigationHeight === 42 && value.defaultRoute === "groups" && Array.isArray(value.routes) && value.routes.every((route) => managerRoutes.includes(route as typeof managerRoutes[number])) && hasOnlyKeys(value, ["width", "height", "headerHeight", "navigationHeight", "defaultRoute", "routes"]);
}
function validManagerError(value: unknown): boolean {
  if (!validRecord(value) || !["validation", "reference", "persistence", "offline", "transport"].includes(value.kind as string) || !validString(value.message) || !hasOnlyKeys(value, ["kind", "message", "code", "field"])) return false;
  return (value.code === undefined || validString(value.code)) && (value.field === undefined || validString(value.field));
}
function validManagerResponse(value: unknown): boolean {
  if (!validRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    if (!hasOnlyKeys(value, ["ok", "configuration", "view", "viewFixture"]) || !validConfiguration(value.configuration) || !validView(value.view)) return false;
    if (value.viewFixture === undefined) return true;
    if (!validRecord(value.viewFixture) || !validRecord(value.viewFixture.persistentTabsByGroup) || !hasOnlyKeys(value.viewFixture, ["persistentTabsByGroup"])) return false;
    return Object.values(value.viewFixture.persistentTabsByGroup).every((fixture) => validRecord(fixture) && ["loading", "empty", "populated", "disabled", "error"].includes(fixture.state as string) && Array.isArray(fixture.tabs) && fixture.tabs.every(validString) && hasOnlyKeys(fixture, ["state", "tabs"]));
  }
  return hasOnlyKeys(value, ["ok", "error"]) && validManagerError(value.error);
}
function validMessage(value: unknown): boolean {
  if (!validRecord(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.kind === "manager-query") return hasOnlyKeys(message, ["kind"]);
  if (message.kind !== "manager-command" || !message.command || typeof message.command !== "object" || !hasOnlyKeys(message, ["kind", "command"])) return false;
  const command = message.command as Record<string, unknown>;
  if (!validString(command.kind)) return false;
  if (command.kind === "updateGroup") return hasOnlyKeys(command, ["kind", "groupId", "patch"]) && validString(command.groupId) && validRecord(command.patch) && hasOnlyKeys(command.patch, ["name", "emoji", "color", "enabled", "isPersistent", "defaultOrder", "defaultCollapsed", "pausedUntil"]) && (command.patch.name === undefined || validString(command.patch.name)) && (command.patch.emoji === undefined || typeof command.patch.emoji === "string") && (command.patch.color === undefined || groupColors.includes(command.patch.color as typeof groupColors[number])) && (command.patch.enabled === undefined || typeof command.patch.enabled === "boolean") && (command.patch.isPersistent === undefined || typeof command.patch.isPersistent === "boolean") && (command.patch.defaultOrder === undefined || validFiniteNumber(command.patch.defaultOrder)) && (command.patch.defaultCollapsed === undefined || typeof command.patch.defaultCollapsed === "boolean") && (command.patch.pausedUntil === undefined || validFiniteNumber(command.patch.pausedUntil) || command.patch.pausedUntil === "restart");
  if (command.kind === "createGroup") return hasOnlyKeys(command, ["kind", "input"]) && validRecord(command.input) && hasOnlyKeys(command.input, ["name", "color", "emoji", "isPersistent", "defaultCollapsed"]) && validString(command.input.name) && groupColors.includes(command.input.color as typeof groupColors[number]) && (command.input.emoji === undefined || typeof command.input.emoji === "string") && (command.input.isPersistent === undefined || typeof command.input.isPersistent === "boolean") && (command.input.defaultCollapsed === undefined || typeof command.input.defaultCollapsed === "boolean");
  if (command.kind === "deleteGroup") return hasOnlyKeys(command, ["kind", "groupId"]) && validString(command.groupId);
  if (command.kind === "duplicateRule" || command.kind === "deleteRule") return hasOnlyKeys(command, ["kind", "ruleId"]) && validString(command.ruleId);
  if (command.kind === "setRuleEnabled") return hasOnlyKeys(command, ["kind", "ruleId", "enabled"]) && validString(command.ruleId) && typeof command.enabled === "boolean";
  if (command.kind === "setRulePaused") return hasOnlyKeys(command, ["kind", "ruleId", "pausedUntil"]) && validString(command.ruleId) && (command.pausedUntil === undefined || validFiniteNumber(command.pausedUntil) || command.pausedUntil === "restart");
  if (command.kind === "saveRule") return hasOnlyKeys(command, ["kind", "rule"]) && validRecord(command.rule) && validRule(command.rule, true);
  return false;
}
function validTransportRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.recordType === "event") return (record.mode === "fixture" || record.mode === "real") && ["page", "worker", "transport"].includes(record.source as string) && typeof record.at === "number" && Number.isFinite(record.at) && validString(record.name) && validRecord(record.details) && validDetails(record.details) && hasOnlyKeys(record, ["recordType", "mode", "source", "at", "name", "details"]);
  if (record.recordType !== "request" || (record.mode !== "fixture" && record.mode !== "real") || !validString(record.requestId) || typeof record.sequence !== "number" || !Number.isInteger(record.sequence) || !validMessage(record.message) || !validFiniteNumber(record.startedAt) || !validFiniteNumber(record.latencyMs)) return false;
  if (record.mode === "fixture" && (!validString(record.scenarioId) || "workerGeneration" in record)) return false;
  if (record.mode === "real" && ("scenarioId" in record || (record.workerGeneration !== undefined && (!Number.isInteger(record.workerGeneration) || !validFiniteNumber(record.workerGeneration))))) return false;
  if (record.state === "pending") return hasOnlyKeys(record, ["recordType", "mode", "requestId", "sequence", "scenarioId", "workerGeneration", "message", "startedAt", "latencyMs", "state"]);
  if (record.state === "resolved") return typeof record.endedAt === "number" && Number.isFinite(record.endedAt) && validManagerResponse(record.response) && hasOnlyKeys(record, ["recordType", "mode", "requestId", "sequence", "scenarioId", "workerGeneration", "message", "startedAt", "latencyMs", "state", "endedAt", "response"]);
  if (record.state === "rejected") return typeof record.endedAt === "number" && Number.isFinite(record.endedAt) && validManagerError(record.error) && hasOnlyKeys(record, ["recordType", "mode", "requestId", "sequence", "scenarioId", "workerGeneration", "message", "startedAt", "latencyMs", "state", "endedAt", "error"]);
  return false;
}
function validLease(value: unknown, status?: LeaseRecord["status"]): value is LeaseRecord {
  if (!value || typeof value !== "object") return false;
  const lease = value as Record<string, unknown>;
  return validString(lease.runId) && typeof lease.pid === "number" && Number.isInteger(lease.pid) && validString(lease.startedAt) && validString(lease.heartbeat) && validString(lease.profilePath) && hasOnlyKeys(lease, ["runId", "pid", "startedAt", "heartbeat", "profilePath", "status"]) && (lease.status === (status ?? lease.status)) && (status ? lease.status === status : lease.status === "active" || lease.status === "completed");
}
export function validateStartedMetadata(value: unknown): value is RunResultStartedMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!validString(item.runId) || !validString(item.worktreePath) || !validString(item.buildPath) || !validString(item.profilePath) || (item.mode !== "fixture" && item.mode !== "real") || !validString(item.url) || !validString(item.scenario)) return false;
  const deepLink = item.deepLink;
  const validDeepLink = deepLink === "none" || deepLink === "new-rule" || (deepLink && typeof deepLink === "object" && ["edit-rule", "confirm-delete"].includes((deepLink as Record<string, unknown>).kind as string) && validString((deepLink as Record<string, unknown>).ruleId) && hasOnlyKeys(deepLink as Record<string, unknown>, ["kind", "ruleId"]));
  if (!["groups", "rules", "activity", "settings"].includes(item.route as string) || !validDeepLink) return false;
  if (!Array.isArray(item.commandRecords) || !item.commandRecords.every(validTransportRecord) || !item.readiness || typeof item.readiness !== "object" || !hasOnlyKeys(item.readiness as Record<string, unknown>, ["workerDiscoveredAt", "managerQuerySettledAt"]) || !Object.values(item.readiness as Record<string, unknown>).every((entry) => typeof entry === "string") || !Array.isArray(item.screenshotPaths) || !item.screenshotPaths.every((entry) => typeof entry === "string") || !Array.isArray(item.assertions) || !item.assertions.every((entry) => entry && typeof entry === "object" && validString((entry as Record<string, unknown>).name) && typeof (entry as Record<string, unknown>).passed === "boolean" && validDetails((entry as Record<string, unknown>).details) && hasOnlyKeys(entry as Record<string, unknown>, ["name", "passed", "details"])) || !validLease(item.lease) || !item.cleanup || typeof item.cleanup !== "object") return false;
  const cleanup = item.cleanup as Record<string, unknown>;
  return typeof cleanup.profileRemoved === "boolean" && hasOnlyKeys(cleanup, ["profileRemoved", "retainedPath"]) && (!('retainedPath' in cleanup) || validString(cleanup.retainedPath));
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
    if (result.ok) return cleanup.profileRemoved === true && (!('extensionId' in result) || typeof result.extensionId === "string") && hasOnlyKeys(result, ["ok", "status", "runId", "worktreePath", "buildPath", "profilePath", "mode", "url", "scenario", "route", "deepLink", "commandRecords", "readiness", "screenshotPaths", "assertions", "lease", "cleanup", "extensionId"]);
    return result.code === "WORKBENCH_CLEANUP_FAILED" && result.phase === "cleanup" && validBoundedError(result.error) && (!('extensionId' in result) || typeof result.extensionId === "string") && hasOnlyKeys(result, ["ok", "status", "code", "phase", "runId", "worktreePath", "buildPath", "profilePath", "mode", "url", "scenario", "route", "deepLink", "commandRecords", "readiness", "screenshotPaths", "assertions", "lease", "cleanup", "extensionId", "error"]);
  }
  if (result.status !== "failed" || result.ok !== false || typeof result.code !== "string" || typeof result.phase !== "string") return false;
  if (result.code === "WORKBENCH_ARGUMENT" || result.code === "WORKBENCH_CAPACITY") return !("extensionId" in result) && result.phase === (result.code === "WORKBENCH_ARGUMENT" ? "argument" : "capacity") && typeof result.runId === "string" && typeof result.worktreePath === "string" && validBoundedError(result.error) && hasOnlyKeys(result, ["ok", "status", "code", "phase", "runId", "worktreePath", "error"]);
  if (result.code === "WORKBENCH_ARTIFACT_LIMIT" && result.phase === "artifact" && validBoundedError(result.error) && typeof result.runId === "string" && typeof result.worktreePath === "string" && validLease(result.lease, "active") && typeof result.buildPath === "string" && typeof result.profilePath === "string" && result.cleanup && typeof result.cleanup === "object") {
    const cleanup = result.cleanup as Record<string, unknown>;
    return hasOnlyKeys(result, ["ok", "status", "code", "phase", "runId", "worktreePath", "buildPath", "profilePath", "lease", "cleanup", "error", "extensionId"]) && hasOnlyKeys(cleanup, ["profileRemoved", "retainedPath"]) && typeof cleanup.profileRemoved === "boolean" && (cleanup.profileRemoved ? !('retainedPath' in cleanup) : typeof cleanup.retainedPath === "string") && (!('extensionId' in result) || typeof result.extensionId === "string");
  }
  if (!validateStartedMetadata(result) || !validBoundedError(result.error)) return false;
  const startedKeys = ["ok", "status", "code", "phase", "runId", "worktreePath", "buildPath", "profilePath", "mode", "url", "scenario", "route", "deepLink", "commandRecords", "readiness", "screenshotPaths", "assertions", "lease", "cleanup", "extensionId", "error"];
  if (!hasOnlyKeys(result, startedKeys)) return false;
  if (result.code === "WORKBENCH_MANAGER_TIMEOUT") return result.phase === "manager-query" && typeof result.extensionId === "string";
  if (result.code === "WORKBENCH_WORKER_TIMEOUT") return (result.phase === "worker" && !("extensionId" in result)) || ((result.phase === "restart-termination" || result.phase === "restart-wake") && typeof result.extensionId === "string");
  return (result.code === "WORKBENCH_CLEANUP_FAILED" && result.phase === "cleanup" && (!('extensionId' in result) || typeof result.extensionId === "string")) || (result.code === "WORKBENCH_ARTIFACT_LIMIT" && result.phase === "artifact" && (!('extensionId' in result) || typeof result.extensionId === "string"));
}
