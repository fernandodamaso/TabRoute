import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CrossProcessLock } from "./contracts";

export interface LockOptions {
  pid?: number;
  runId?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => Promise<boolean | undefined>;
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
  maxAttempts?: number;
  failureCode?: "WORKBENCH_CAPACITY" | "WORKBENCH_ARTIFACT_LIMIT";
  beforeStaleRemove?: () => Promise<void>;
  beforeHeartbeatReplace?: () => Promise<void>;
  beforeReleaseRemove?: () => Promise<void>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

interface LockOwner {
  pid: number;
  runId: string;
  heartbeat: number;
  token: string;
  mtimeHeartbeat?: true;
}

interface OwnerSnapshot {
  owner?: LockOwner;
  mtimeMs: number;
  dev: number;
  ino: number;
}

const TWO_MINUTES_MS = 2 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function isOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return Number.isInteger(owner.pid) && typeof owner.runId === "string" && typeof owner.heartbeat === "number" && Number.isFinite(owner.heartbeat) && typeof owner.token === "string" && (owner.mtimeHeartbeat === undefined || owner.mtimeHeartbeat === true);
}

async function readSnapshot(filePath: string): Promise<OwnerSnapshot | undefined> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
    let owner: LockOwner | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isOwner(parsed)) owner = parsed;
    } catch { /* malformed owner is recovered only by the conservative timeout */ }
    return { owner, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameFile(left: OwnerSnapshot, right: OwnerSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function stale(snapshot: OwnerSnapshot, now: () => number, isPidAlive: (pid: number) => Promise<boolean | undefined>): Promise<boolean> {
  if (!snapshot.owner) return now() - snapshot.mtimeMs > TEN_MINUTES_MS;
  const heartbeat = snapshot.owner.mtimeHeartbeat ? snapshot.mtimeMs : snapshot.owner.heartbeat;
  const age = now() - heartbeat;
  if (age <= TWO_MINUTES_MS) return false;
  const live = await isPidAlive(snapshot.owner.pid);
  if (live === false) return true;
  return live === undefined && age > TEN_MINUTES_MS;
}

export function createCrossProcessLock(lockPath: string, supplied: LockOptions = {}): CrossProcessLock {
  const absolute = path.resolve(lockPath);
  const guardPath = `${absolute}.guard`;
  const now = supplied.now ?? Date.now;
  const isPidAlive = supplied.isPidAlive ?? (async (pid) => {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  });
  const sleep = supplied.sleep ?? defaultSleep;
  const retryDelayMs = supplied.retryDelayMs ?? 25;
  const maxAttempts = supplied.maxAttempts ?? 40;
  const failure = () => {
    const error = new Error(supplied.failureCode ?? "WORKBENCH_CAPACITY") as Error & { code: string; phase: string };
    error.code = supplied.failureCode ?? "WORKBENCH_CAPACITY";
    error.phase = supplied.failureCode === "WORKBENCH_ARTIFACT_LIMIT" ? "artifact" : "capacity";
    return error;
  };

  async function acquireGuard(): Promise<() => Promise<void>> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const token = crypto.randomUUID();
      const ownerPath = path.join(guardPath, `owner-${token}.json`);
      try {
        await fs.mkdir(guardPath);
        await fs.writeFile(ownerPath, JSON.stringify({ pid: supplied.pid ?? process.pid, runId: supplied.runId ?? "unknown", heartbeat: now(), token }));
        return async () => {
          await fs.rm(ownerPath, { force: true }).catch(() => undefined);
          for (let releaseAttempt = 0; releaseAttempt < 5; releaseAttempt += 1) {
            try { await fs.rmdir(guardPath); return; }
            catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "ENOENT") return;
              if (code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EBUSY") throw error;
              await sleep(1);
            }
          }
          throw failure();
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const entries = await fs.readdir(guardPath);
          if (entries.length === 0) {
            const stat = await fs.stat(guardPath);
            if (now() - stat.mtimeMs > TEN_MINUTES_MS) await fs.rmdir(guardPath).catch(() => undefined);
          } else if (entries.length === 1 && entries[0]?.startsWith("owner-") && entries[0].endsWith(".json")) {
            const existingPath = path.join(guardPath, entries[0]);
            const snapshot = await readSnapshot(existingPath);
            if (snapshot && await stale(snapshot, now, isPidAlive)) {
              await fs.rm(existingPath, { force: true });
              await fs.rmdir(guardPath).catch(() => undefined);
            }
          }
        } catch { /* another process owns or is releasing the guard */ }
        await sleep(retryDelayMs);
      }
    }
    throw failure();
  }

  async function withGuard<T>(operation: () => Promise<T>): Promise<T> {
    const releaseGuard = await acquireGuard();
    try { return await operation(); } finally { await releaseGuard(); }
  }

  return {
    async acquire() {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const owner: LockOwner = { pid: supplied.pid ?? process.pid, runId: supplied.runId ?? "unknown", heartbeat: now(), token: crypto.randomUUID(), mtimeHeartbeat: true };
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        await withGuard(async () => {
          const create = async () => {
            const candidate = await fs.open(absolute, "wx");
            try {
              await candidate.writeFile(JSON.stringify(owner), "utf8");
              await candidate.sync();
              handle = candidate;
            } catch (error) {
              await candidate.close().catch(() => undefined);
              await fs.rm(absolute, { force: true }).catch(() => undefined);
              throw error;
            }
          };
          try {
            await create();
            return;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            let contention = code === "EEXIST";
            if (code === "EPERM") { try { await fs.access(absolute); contention = true; } catch { contention = false; } }
            if (!contention) throw error;
          }
          const observed = await readSnapshot(absolute);
          if (!observed || !await stale(observed, now, isPidAlive)) return;
          await supplied.beforeStaleRemove?.();
          const current = await readSnapshot(absolute);
          if (!current || !sameFile(observed, current) || current.owner?.token !== observed.owner?.token || !await stale(current, now, isPidAlive)) return;
          await fs.rm(absolute, { force: true });
          await create();
        });
        if (!handle) {
          await sleep(retryDelayMs);
          continue;
        }

        let held = true;
        let heartbeatTask: Promise<void> | undefined;
        const timer = (supplied.setInterval ?? setInterval)(() => {
          if (!held || heartbeatTask) return;
          heartbeatTask = (async () => {
            try {
              await supplied.beforeHeartbeatReplace?.();
              const current = await readSnapshot(absolute);
              const heldSnapshot = await handle!.stat();
              if (!current || current.owner?.token !== owner.token || current.dev !== heldSnapshot.dev || current.ino !== heldSnapshot.ino) return;
              const heartbeatAt = new Date(now());
              await handle!.utimes(heartbeatAt, heartbeatAt);
              await handle!.sync();
            } catch { /* replacement owners and disappearing paths are never modified */ }
          })().finally(() => { heartbeatTask = undefined; });
        }, 5000);
        timer.unref?.();

        return {
          release: async () => {
            (supplied.clearInterval ?? clearInterval)(timer);
            if (!held) return;
            held = false;
            await heartbeatTask;
            try {
              await withGuard(async () => {
                const observed = await readSnapshot(absolute);
                const heldStat = await handle!.stat();
                if (!observed || observed.owner?.token !== owner.token || observed.dev !== heldStat.dev || observed.ino !== heldStat.ino) return;
                await supplied.beforeReleaseRemove?.();
                const current = await readSnapshot(absolute);
                if (!current || current.owner?.token !== owner.token || !sameFile(observed, current)) return;
                await fs.rm(absolute, { force: true });
              });
            } finally {
              await handle!.close().catch(() => undefined);
            }
          }
        };
      }
      throw failure();
    },
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      const lease = await this.acquire();
      try { return await operation(); } finally { await lease.release(); }
    }
  };
}
