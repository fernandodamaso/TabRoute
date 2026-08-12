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
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

interface LockOwner { pid: number; runId: string; heartbeat: number; token: string; }
const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function stale(owner: LockOwner | undefined, options: Required<Pick<LockOptions, "now" | "isPidAlive">>): Promise<boolean> {
  if (!owner) return false;
  const age = options.now() - owner.heartbeat;
  if (age <= 2 * 60 * 1000) return false;
  const live = await options.isPidAlive(owner.pid);
  if (live === false) return true;
  return live === undefined && age > 10 * 60 * 1000;
}

export function createCrossProcessLock(lockPath: string, supplied: LockOptions = {}): CrossProcessLock {
  const absolute = path.resolve(lockPath);
  const now = supplied.now ?? Date.now;
  const isPidAlive = supplied.isPidAlive ?? (async (pid) => {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  });
  const sleep = supplied.sleep ?? defaultSleep;
  const retryDelayMs = supplied.retryDelayMs ?? 25;
  const maxAttempts = supplied.maxAttempts ?? 40;
  let held = false;
  return {
    async acquire() {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const owner: LockOwner = { pid: supplied.pid ?? process.pid, runId: supplied.runId ?? "unknown", heartbeat: now(), token: crypto.randomUUID() };
        try {
          const handle = await fs.open(absolute, "wx");
          await handle.writeFile(JSON.stringify(owner), "utf8");
          held = true;
          const timer = (supplied.setInterval ?? setInterval)(() => {
            const refreshed = { ...owner, heartbeat: now() };
            void (async () => {
              try {
                await supplied.beforeHeartbeatReplace?.();
                // Keep the acquired descriptor open. If another owner replaces
                // the path, this descriptor still points to the old inode and
                // cannot overwrite the replacement path between validation and
                // mutation.
                const current = JSON.parse(await fs.readFile(absolute, "utf8")) as LockOwner;
                if (current.token !== owner.token) return;
                await handle.truncate(0);
                await handle.writeFile(JSON.stringify(refreshed), "utf8");
                await handle.sync();
              } catch { /* owner was replaced or lock became unreadable */ }
            })();
          }, 5000);
          timer.unref?.();
          return { release: async () => {
            (supplied.clearInterval ?? clearInterval)(timer);
            if (!held) return;
            held = false;
            try {
              const content = JSON.parse(await fs.readFile(absolute, "utf8")) as LockOwner;
              if (content.token === owner.token) await fs.rm(absolute, { force: true });
            } catch { /* another owner recovered it */ }
            await handle.close().catch(() => undefined);
          } };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          let contention = code === "EEXIST";
          if (code === "EPERM") { try { await fs.access(absolute); contention = true; } catch { contention = false; } }
          if (!contention) throw error;
          try {
            const current = JSON.parse(await fs.readFile(absolute, "utf8")) as LockOwner;
            if (await stale(current, { now, isPidAlive })) {
              await supplied.beforeStaleRemove?.();
              // Claim the path with one atomic rename. The claimed inode is then
              // inspected before removal, so a replacement owner is never
              // removed by a second path-based mutation.
              const claim = `${absolute}.stale-${process.pid}-${crypto.randomUUID()}`;
              await fs.rename(absolute, claim);
              const claimed = JSON.parse(await fs.readFile(claim, "utf8")) as LockOwner;
              if (claimed.token === current.token && claimed.heartbeat === current.heartbeat) {
                await fs.rm(claim, { force: true });
              } else {
                try { await fs.access(absolute); } catch { await fs.rename(claim, absolute); }
              }
            }
          } catch { /* partial owner file: retry without deleting it */ }
          await sleep(retryDelayMs);
        }
      }
      const error = new Error(supplied.failureCode ?? "WORKBENCH_CAPACITY") as Error & { code: string; phase: string };
      error.code = supplied.failureCode ?? "WORKBENCH_CAPACITY";
      error.phase = supplied.failureCode === "WORKBENCH_ARTIFACT_LIMIT" ? "artifact" : "capacity";
      throw error;
    },
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      const lease = await this.acquire();
      try { return await operation(); } finally { await lease.release(); }
    }
  };
}
