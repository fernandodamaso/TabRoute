import { describe, expect, it } from "vitest";
import {
  REQUIRED_METADATA_CAPS,
  REQUIRED_METADATA_RESERVATION_BYTES,
  createArtifactLimitFailure,
  validateStartedMetadata,
  validateRunResult,
  type RunResultStartedMetadata
} from "../../scripts/workbench/contracts";

const metadata: RunResultStartedMetadata = {
  status: "failed",
  runId: "run-1",
  worktreePath: "C:/worktree",
  buildPath: "C:/worktree/.workbench/tmp/run-1/build",
  profilePath: "C:/Temp/profile-run-1",
  mode: "fixture",
  url: "http://fixture",
  scenario: "default",
  route: "groups",
  deepLink: "none",
  commandRecords: [],
  readiness: {},
  screenshotPaths: [],
  assertions: [],
  lease: {
    runId: "run-1", pid: 1, startedAt: "2026-01-01T00:00:00.000Z",
    heartbeat: "2026-01-01T00:00:00.000Z", profilePath: "C:/Temp/profile-run-1", status: "active"
  },
  cleanup: { profileRemoved: false }
};

describe("workbench RunResult contracts", () => {
  it("accepts a worker timeout without an extension id", () => {
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", error: { message: "worker timed out" } })).toBe(true);
  });

  it("requires a discovered extension id for manager and restart failures", () => {
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_MANAGER_TIMEOUT", phase: "manager-query", error: { message: "manager timed out" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_MANAGER_TIMEOUT", phase: "manager-query", extensionId: "abc", error: { message: "manager timed out" } })).toBe(true);
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "restart-wake", error: { message: "restart wake failed" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "restart-wake", extensionId: "abc", error: { message: "restart wake failed" } })).toBe(true);
  });

  it("keeps unknown artifact failures bounded and without an invented id", () => {
    const result = createArtifactLimitFailure({ ...metadata, commandRecords: Array.from({ length: 5000 }, () => ({ recordType: "event", mode: "fixture", source: "page", at: 1, name: "x", details: {} })) }, { message: "metadata too large" });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("WORKBENCH_ARTIFACT_LIMIT");
    expect("extensionId" in result).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(REQUIRED_METADATA_RESERVATION_BYTES);
    expect(result).not.toHaveProperty("commandRecords");
  });

  it("exposes the required metadata caps as a stable public contract", () => {
    expect(REQUIRED_METADATA_CAPS).toEqual({ maxCommandRecords: 1000, maxEventRecords: 1000, maxAssertions: 1000, maxScreenshotPaths: 500, maxStringBytes: 4096, maxUrlBytes: 16384, maxErrorBytes: 8192 });
  });

  it("rejects extension ids and phase fields that do not belong to a union member", () => {
    expect(validateRunResult({ runId: "run", worktreePath: "x", ok: false, status: "failed", code: "WORKBENCH_ARGUMENT", phase: "argument", extensionId: "invented", error: { message: "bad" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, status: "failed", code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", extensionId: "invented", error: { message: "bad" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, status: "failed", code: "WORKBENCH_MANAGER_TIMEOUT", phase: "worker", extensionId: "abc", error: { message: "bad" } })).toBe(false);
  });

  it("rejects malformed started and abandoned metadata", () => {
    expect(validateStartedMetadata({ ...metadata, route: "not-a-route" })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: true, status: "abandoned", lease: { ...metadata.lease, status: "abandoned" }, cleanup: { profileRemoved: true, retainedPath: "invented" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, status: "abandoned", lease: { ...metadata.lease, status: "abandoned" }, cleanup: { profileRemoved: false }, error: { message: "cleanup" }, code: "WORKBENCH_CLEANUP_FAILED", phase: "cleanup" })).toBe(false);
  });

  it("rejects malformed nested records, readiness, screenshots, assertions, and cleanup", () => {
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", commandRecords: [{ recordType: "event", mode: "fixture", source: "page", at: "not-a-number", name: "x", details: {} }], error: { message: "bad" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", readiness: { workerDiscoveredAt: 42 }, error: { message: "bad" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", screenshotPaths: [42], error: { message: "bad" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", assertions: [{ name: "x", passed: "yes" }], error: { message: "bad" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", cleanup: { profileRemoved: "no" }, error: { message: "bad" } })).toBe(false);
  });

  it("requires a string worktree path and optional artifact extension id type", () => {
    expect(validateRunResult({ ...metadata, ok: false, worktreePath: 42, code: "WORKBENCH_ARTIFACT_LIMIT", phase: "artifact", error: { message: "bad" } })).toBe(false);
    expect(validateRunResult({ ...metadata, ok: false, code: "WORKBENCH_ARTIFACT_LIMIT", phase: "artifact", extensionId: 42, error: { message: "bad" } })).toBe(false);
  });

  it("accepts exact pending request records and rejects pending extras", () => {
    const pending = { recordType: "request", mode: "fixture", requestId: "request-1", sequence: 1, scenarioId: "default", message: { kind: "manager-query" }, startedAt: 1, latencyMs: 0, state: "pending" };
    expect(validateRunResult({ ...metadata, commandRecords: [pending], ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", error: { message: "pending" } })).toBe(true);
    expect(validateRunResult({ ...metadata, commandRecords: [{ ...pending, endedAt: 2 }], ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", error: { message: "pending" } })).toBe(false);
  });

  it("distinguishes encoded reservation boundaries", () => {
    const minus = new TextEncoder().encode(JSON.stringify({ value: "x".repeat(REQUIRED_METADATA_RESERVATION_BYTES - 100) })).byteLength;
    const exact = new TextEncoder().encode(JSON.stringify({ value: "x".repeat(REQUIRED_METADATA_RESERVATION_BYTES - 13) })).byteLength;
    const plus = new TextEncoder().encode(JSON.stringify({ value: "x".repeat(REQUIRED_METADATA_RESERVATION_BYTES + 100) })).byteLength;
    expect(minus).toBeLessThan(REQUIRED_METADATA_RESERVATION_BYTES);
    expect(exact).toBeLessThanOrEqual(REQUIRED_METADATA_RESERVATION_BYTES);
    expect(plus).toBeGreaterThan(REQUIRED_METADATA_RESERVATION_BYTES);
  });
});
