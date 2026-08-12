import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CrossProcessLock } from "./contracts";
async function writeOwner(filePath: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, filePath); } catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

export interface LockOptions {
  pid?: number;
  runId?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => Promise<boolean | undefined>;
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
  maxAttempts?: number;
  failureCode?: "WORKBENCH_CAPACITY" | "WORKBENCH_ARTIFACT_LIMIT";
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
          await handle.close();
          held = true;
          const timer = setInterval(() => {
            const refreshed = { ...owner, heartbeat: now() };
            void writeOwner(absolute, new TextEncoder().encode(JSON.stringify(refreshed))).catch(() => undefined);
          }, 5000);
          timer.unref?.();
          return { release: async () => {
            clearInterval(timer);
            if (!held) return;
            held = false;
            try {
              const content = JSON.parse(await fs.readFile(absolute, "utf8")) as LockOwner;
              if (content.token === owner.token) await fs.rm(absolute, { force: true });
            } catch { /* another owner recovered it */ }
          } };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          let contention = code === "EEXIST";
          if (code === "EPERM") { try { await fs.access(absolute); contention = true; } catch { contention = false; } }
          if (!contention) throw error;
          try {
            const current = JSON.parse(await fs.readFile(absolute, "utf8")) as LockOwner;
            if (await stale(current, { now, isPidAlive })) {
              const revalidated = JSON.parse(await fs.readFile(absolute, "utf8")) as LockOwner;
              if (revalidated.token === current.token && revalidated.heartbeat === current.heartbeat) await fs.rm(absolute, { force: true });
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
