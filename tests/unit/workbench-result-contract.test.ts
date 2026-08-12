import { describe, expect, it } from "vitest";
import {
  REQUIRED_METADATA_CAPS,
  REQUIRED_METADATA_RESERVATION_BYTES,
  createArtifactLimitFailure,
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
    const result = createArtifactLimitFailure(metadata, { message: "metadata too large" });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("WORKBENCH_ARTIFACT_LIMIT");
    expect("extensionId" in result).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(REQUIRED_METADATA_RESERVATION_BYTES);
  });

  it("exposes the required metadata caps as a stable public contract", () => {
    expect(REQUIRED_METADATA_CAPS).toEqual({ maxCommandRecords: 1000, maxEventRecords: 1000, maxAssertions: 1000, maxScreenshotPaths: 500, maxStringBytes: 4096, maxUrlBytes: 16384, maxErrorBytes: 8192 });
  });
});
