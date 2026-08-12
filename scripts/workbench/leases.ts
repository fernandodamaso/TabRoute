import { promises as fs } from "node:fs";
import path from "node:path";
import type { AbandonedCleanupFailure, AbandonedRunResult, CapacityFailure, LeaseRecord, RunResult } from "./contracts";
import { writeAtomic } from "./artifacts";
import { createCrossProcessLock } from "./lock";
import { assertOwnedProfilePath, isOwnedProfilePath } from "./paths";
import { boundedError, validateRunResult, validateStartedMetadata } from "./contracts";

export type LeaseLiveness = { kind: "alive" | "dead" | "unavailable" };
export const MAX_ACTIVE_LEASES = 8;
export const HEARTBEAT_INTERVAL_MS = 5000;
export const STALE_HEARTBEAT_MS = 2 * 60 * 1000;
export const CONSERVATIVE_STALE_MS = 10 * 60 * 1000;
export const CLEANUP_BACKOFF_MS = [250, 500, 1000] as const;

export function isLeaseReapable(lease: LeaseRecord, now: Date, liveness: LeaseLiveness): boolean {
  const age = now.getTime() - Date.parse(lease.heartbeat);
  if (liveness.kind === "dead") return age > STALE_HEARTBEAT_MS;
  if (liveness.kind === "unavailable") return age > CONSERVATIVE_STALE_MS;
  return false;
}

export interface LeaseManagerOptions {
  artifactRoot: string;
  worktreePath: string;
  now?: () => Date;
  pid?: number;
  isProcessAlive?: (pid: number) => Promise<boolean | undefined>;
  sleep?: (milliseconds: number) => Promise<void>;
  cleanup?: (profilePath: string) => Promise<void>;
  profileRoot?: string;
}

export class LeaseManager {
  private readonly root: string;
  private readonly lock: ReturnType<typeof createCrossProcessLock>;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly isProcessAlive: (pid: number) => Promise<boolean | undefined>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cleanup: (profilePath: string) => Promise<void>;
  private readonly profileRoot: string;
  constructor(private readonly options: LeaseManagerOptions) {
    this.root = path.resolve(options.artifactRoot);
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? (async (pid) => {
      if (pid === process.pid) return true;
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    });
    this.sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.cleanup = options.cleanup ?? (async (profilePath) => { await fs.rm(profilePath, { recursive: true, force: true }); });
    this.profileRoot = path.resolve(options.profileRoot ?? path.join(path.dirname(this.options.artifactRoot), "profiles"));
    this.lock = createCrossProcessLock(path.join(this.root, ".lock"), { runId: "lease-manager", isPidAlive: this.isProcessAlive });
  }
  validateProfilePath(profilePath: string | undefined, runId: string): profilePath is string {
    return isOwnedProfilePath(profilePath, this.profileRoot, runId, this.options.worktreePath);
  }
  private runDirectory(runId: string): string {
    if (!runId || runId.includes("/") || runId.includes("\\")) throw new Error("WORKBENCH_ARGUMENT");
    const directory = path.resolve(this.root, runId);
    if (directory === this.root || !directory.startsWith(`${this.root}${path.sep}`)) throw new Error("WORKBENCH_PATH_BOUNDARY");
    return directory;
  }
  private async readLeases(): Promise<LeaseRecord[]> {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(this.root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("WORKBENCH_CAPACITY"); }
    const leases: LeaseRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.root, entry.name, "lease.json"), "utf8")) as LeaseRecord;
        if (!parsed || parsed.runId !== entry.name || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt)) || typeof parsed.heartbeat !== "string" || !Number.isFinite(Date.parse(parsed.heartbeat)) || typeof parsed.profilePath !== "string" || !parsed.profilePath || !["active", "abandoned", "completed"].includes(parsed.status)) throw new Error("WORKBENCH_CAPACITY");
        leases.push(parsed);
      } catch { throw new Error("WORKBENCH_CAPACITY"); }
    }
    return leases;
  }
  async countActive(): Promise<number> {
    return this.lock.withLock(async () => {
      const now = this.now();
      let count = 0;
      for (const lease of await this.readLeases()) {
        if (lease.status !== "active") continue;
        const alive = await this.isProcessAlive(lease.pid);
        const liveness: LeaseLiveness = alive === undefined ? { kind: "unavailable" } : alive ? { kind: "alive" } : { kind: "dead" };
        if (!isLeaseReapable(lease, now, liveness)) count += 1;
      }
      return count;
    });
  }
  async createLease(record: Omit<LeaseRecord, "status"> & { status?: LeaseRecord["status"] }): Promise<LeaseRecord | CapacityFailure> {
    if (!this.validateProfilePath(record.profilePath, record.runId)) return { ok: false, status: "failed", code: "WORKBENCH_CAPACITY", phase: "capacity", runId: record.runId, worktreePath: this.options.worktreePath, error: { message: "profile path is not owned by this run" } };
    try { return await this.lock.withLock(async () => {
      const active = await this.countActiveUnlocked();
      if (active >= MAX_ACTIVE_LEASES) return { ok: false, status: "failed", code: "WORKBENCH_CAPACITY", phase: "capacity", runId: record.runId, worktreePath: this.options.worktreePath, error: { message: "workbench active lease capacity reached" } };
      const lease: LeaseRecord = { ...record, status: record.status ?? "active" };
      const directory = this.runDirectory(record.runId);
      await fs.mkdir(directory, { recursive: true });
      await writeAtomic(path.join(directory, "lease.json"), new TextEncoder().encode(JSON.stringify(lease)));
      return lease;
    }); } catch (error) { return { ok: false, status: "failed", code: "WORKBENCH_CAPACITY", phase: "capacity", runId: record.runId, worktreePath: this.options.worktreePath, error: { message: error instanceof Error ? error.message : "workbench capacity unavailable" } }; }
  }
  create(record: Omit<LeaseRecord, "status"> & { status?: LeaseRecord["status"] }) { return this.createLease(record); }
  async heartbeat(runId: string, at = this.now().toISOString()): Promise<void> {
    await this.lock.withLock(async () => {
      const directory = this.runDirectory(runId);
      const file = path.join(directory, "lease.json");
      const lease = JSON.parse(await fs.readFile(file, "utf8")) as LeaseRecord;
      await writeAtomic(file, new TextEncoder().encode(JSON.stringify({ ...lease, heartbeat: at })));
    });
  }
  private async countActiveUnlocked(): Promise<number> {
    const now = this.now();
    let count = 0;
    for (const lease of await this.readLeases()) {
      if (lease.status !== "active") continue;
      const alive = await this.isProcessAlive(lease.pid);
      const liveness: LeaseLiveness = alive === undefined ? { kind: "unavailable" } : alive ? { kind: "alive" } : { kind: "dead" };
      if (!isLeaseReapable(lease, now, liveness)) count += 1;
    }
    return count;
  }
  async reapOrphans(): Promise<Array<AbandonedRunResult | AbandonedCleanupFailure>> {
    return this.lock.withLock(async () => {
      const reaped: Array<AbandonedRunResult | AbandonedCleanupFailure> = [];
      for (const lease of await this.readLeases()) {
        if (lease.status !== "active") continue;
        const alive = await this.isProcessAlive(lease.pid);
        const liveness: LeaseLiveness = alive === undefined ? { kind: "unavailable" } : alive ? { kind: "alive" } : { kind: "dead" };
        if (!isLeaseReapable(lease, this.now(), liveness)) continue;
        const directory = this.runDirectory(lease.runId);
        const resultFile = path.join(directory, "results.json");
        let existing: RunResult;
        try { existing = JSON.parse(await fs.readFile(resultFile, "utf8")) as RunResult; } catch { continue; }
        if (!validateRunResult(existing) || existing.status === "abandoned" || !validateStartedMetadata(existing)) continue;
        const abandonedLease = { ...lease, heartbeat: this.now().toISOString(), status: "abandoned" as const };
        let removed = false;
        let lastError: unknown;
        for (let attempt = 0; attempt <= CLEANUP_BACKOFF_MS.length; attempt += 1) {
          try {
            const profile = assertOwnedProfilePath(lease.profilePath, this.profileRoot, lease.runId, this.options.worktreePath);
            await this.cleanup(profile); removed = true; break;
          } catch (error) {
            lastError = error;
            if (attempt === CLEANUP_BACKOFF_MS.length) break;
            const delay = attempt === 0 ? 250 : attempt === 1 ? 500 : 1000;
            await this.sleep(delay);
          }
        }
        const base = {
          status: "abandoned" as const,
          runId: existing.runId, worktreePath: existing.worktreePath, buildPath: existing.buildPath, profilePath: existing.profilePath,
          mode: existing.mode, url: existing.url, scenario: existing.scenario, route: existing.route, deepLink: existing.deepLink,
          commandRecords: existing.commandRecords, readiness: existing.readiness, screenshotPaths: existing.screenshotPaths, assertions: existing.assertions,
          lease: abandonedLease,
          ...(typeof (existing as Partial<RunResult & { extensionId?: unknown }>).extensionId === "string" ? { extensionId: (existing as unknown as { extensionId: string }).extensionId } : {})
        };
        const updated = removed
          ? { ...base, ok: true as const, cleanup: { profileRemoved: true as const } }
          : { ...base, ok: false as const, code: "WORKBENCH_CLEANUP_FAILED" as const, phase: "cleanup" as const, cleanup: { profileRemoved: false as const, retainedPath: lease.profilePath }, error: boundedError({ message: lastError instanceof Error ? lastError.message : "orphan cleanup failed" }) };
        await writeAtomic(resultFile, new TextEncoder().encode(JSON.stringify(updated)));
        await writeAtomic(path.join(directory, "lease.json"), new TextEncoder().encode(JSON.stringify(abandonedLease)));
        reaped.push(updated as AbandonedRunResult | AbandonedCleanupFailure);
      }
      return reaped;
    });
  }
  startHeartbeat(runId: string, timers: Pick<typeof globalThis, "setInterval" | "clearInterval"> = globalThis, beat: () => Promise<void> = () => this.heartbeat(runId)): { stop(): void } {
    const timer = timers.setInterval(() => { void beat(); }, HEARTBEAT_INTERVAL_MS);
    return { stop: () => timers.clearInterval(timer) };
  }
  reap() { return this.reapOrphans(); }
}
