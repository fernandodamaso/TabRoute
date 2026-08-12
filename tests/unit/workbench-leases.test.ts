import { describe, expect, it } from "vitest";
import { isLeaseReapable, LeaseManager, type LeaseLiveness } from "../../scripts/workbench/leases";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("workbench lease lifecycle", () => {
  it("reaps an old lease only when the process is dead", () => {
    const lease = { runId: "run-1", pid: 42, startedAt: "2026-01-01T00:00:00.000Z", heartbeat: "2026-01-01T00:00:00.000Z", profilePath: "C:/Temp/profile", status: "active" as const };
    expect(isLeaseReapable(lease, new Date("2026-01-01T00:03:00.001Z"), { kind: "dead" })).toBe(true);
    expect(isLeaseReapable(lease, new Date("2026-01-01T00:03:00.001Z"), { kind: "alive" })).toBe(false);
  });

  it("uses the conservative ten-minute rule when liveness is unavailable", () => {
    const lease = { runId: "run-1", pid: 42, startedAt: "2026-01-01T00:00:00.000Z", heartbeat: "2026-01-01T00:00:00.000Z", profilePath: "C:/Temp/profile", status: "active" as const };
    const unavailable: LeaseLiveness = { kind: "unavailable" };
    expect(isLeaseReapable(lease, new Date("2026-01-01T00:09:59.999Z"), unavailable)).toBe(false);
    expect(isLeaseReapable(lease, new Date("2026-01-01T00:10:00.001Z"), unavailable)).toBe(true);
  });

  it("accepts only an owned profile path and rejects unsafe cleanup targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-lease-"));
    const profileRoot = path.join(root, "profiles");
    const manager = new LeaseManager({ artifactRoot: path.join(root, "artifacts"), worktreePath: path.join(root, "worktree"), profileRoot, pid: 42, isProcessAlive: async () => true });
    expect(manager.validateProfilePath(path.join(profileRoot, "run-1"), "run-1")).toBe(true);
    for (const candidate of [path.join(root, "worktree", "child"), root, path.join(root, "sibling"), path.join(os.tmpdir(), "unrelated")]) expect(manager.validateProfilePath(candidate, "run-1")).toBe(false);
    expect(manager.validateProfilePath(undefined, "run-1")).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("performs initial cleanup plus exact retries and writes clean abandoned metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-reap-"));
    const artifactRoot = path.join(root, "artifacts");
    const profileRoot = path.join(root, "profiles");
    const profile = path.join(profileRoot, "run-1");
    await mkdir(path.join(artifactRoot, "run-1"), { recursive: true });
    await mkdir(profile, { recursive: true });
    const lease = { runId: "run-1", pid: 42, startedAt: "2020-01-01T00:00:00.000Z", heartbeat: "2020-01-01T00:00:00.000Z", profilePath: profile, status: "active" as const };
    const metadata = { status: "failed", ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", runId: "run-1", worktreePath: path.join(root, "worktree"), buildPath: "build", profilePath: profile, mode: "fixture", url: "url", scenario: "default", route: "groups", deepLink: "none", commandRecords: [], readiness: {}, screenshotPaths: [], assertions: [], lease, cleanup: { profileRemoved: false }, error: { message: "old" } };
    await writeFile(path.join(artifactRoot, "run-1", "lease.json"), JSON.stringify(lease));
    await writeFile(path.join(artifactRoot, "run-1", "results.json"), JSON.stringify(metadata));
    const sleeps: number[] = [];
    let attempts = 0;
    const manager = new LeaseManager({ artifactRoot, worktreePath: path.join(root, "worktree"), profileRoot, now: () => new Date("2020-01-01T00:03:00.000Z"), pid: 99, isProcessAlive: async () => false, sleep: async (ms) => { sleeps.push(ms); }, cleanup: async () => { attempts += 1; if (attempts < 4) throw new Error("locked"); } });
    const results = await manager.reapOrphans();
    expect(sleeps).toEqual([250, 500, 1000]);
    expect(attempts).toBe(4);
    expect(results[0]).toMatchObject({ ok: true, status: "abandoned", cleanup: { profileRemoved: true } });
    expect(results[0]).not.toHaveProperty("code");
    await rm(root, { recursive: true, force: true });
  });

  it("refreshes a five-second heartbeat until stopped", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-heartbeat-"));
    const manager = new LeaseManager({ artifactRoot: path.join(root, "artifacts"), worktreePath: path.join(root, "worktree"), profileRoot: path.join(root, "profiles"), pid: 42, isProcessAlive: async () => true });
    const calls: string[] = [];
    const handle = manager.startHeartbeat("run-1", { setInterval: ((callback: () => void, ms: number) => { calls.push(`start:${ms}`); callback(); return 1 as unknown as NodeJS.Timeout; }) as never, clearInterval: (() => { calls.push("stop"); }) as never }, async () => { calls.push("beat"); });
    handle.stop();
    expect(calls).toEqual(["start:5000", "beat", "stop"]);
    await rm(root, { recursive: true, force: true });
  });
});
