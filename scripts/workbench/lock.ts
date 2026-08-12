import { promises as fs } from "node:fs";
import path from "node:path";
import type { CrossProcessLock } from "./contracts";

export interface LockOptions {
  pid?: number;
  runId?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => Promise<boolean | undefined>;
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
  maxAttempts?: number;
}

interface LockOwner { pid: number; runId: string; heartbeat: number; }
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
        const owner: LockOwner = { pid: supplied.pid ?? process.pid, runId: supplied.runId ?? "unknown", heartbeat: now() };
        try {
          const handle = await fs.open(absolute, "wx");
          await handle.writeFile(JSON.stringify(owner), "utf8");
          await handle.close();
          held = true;
          const timer = setInterval(() => {
            const refreshed = { ...owner, heartbeat: now() };
            void fs.writeFile(absolute, JSON.stringify(refreshed), "utf8").catch(() => undefined);
          }, 5000);
          timer.unref?.();
          return { release: async () => {
            clearInterval(timer);
            if (!held) return;
            held = false;
            try {
              const content = JSON.parse(await fs.readFile(absolute, "utf8")) as LockOwner;
              if (content.pid === owner.pid && content.runId === owner.runId) await fs.rm(absolute, { force: true });
            } catch { /* another owner recovered it */ }
          } };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const current = JSON.parse(await fs.readFile(absolute, "utf8")) as LockOwner;
            if (await stale(current, { now, isPidAlive })) await fs.rm(absolute, { force: true });
          } catch { /* partial owner file: retry without deleting it */ }
          await sleep(retryDelayMs);
        }
      }
      throw new Error("WORKBENCH_LOCK_TIMEOUT");
    },
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      const lease = await this.acquire();
      try { return await operation(); } finally { await lease.release(); }
    }
  };
}
