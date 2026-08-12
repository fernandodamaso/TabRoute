import { createCrossProcessLock } from "../../scripts/workbench/lock";
import { LeaseManager } from "../../scripts/workbench/leases";

const lockPath = process.argv[2];
if (!lockPath) throw new Error("lock path required");
if (process.argv[3] === "lease") {
  const artifactRoot = lockPath;
  const runId = process.argv[4] ?? "worker-run";
  const worktreePath = process.argv[5] ?? process.cwd();
  const profileRoot = `${worktreePath}-profiles`;
  const manager = new LeaseManager({ artifactRoot, worktreePath, profileRoot, pid: process.pid, isProcessAlive: async (pid) => pid === process.pid });
  const result = await manager.createLease({ runId, pid: process.pid, startedAt: new Date().toISOString(), heartbeat: new Date().toISOString(), profilePath: `${profileRoot}/${runId}` });
  process.stdout.write(JSON.stringify("ok" in result ? result : { ok: true, lease: result }));
  process.exit(0);
}
const lock = createCrossProcessLock(lockPath, { retryDelayMs: 5, maxAttempts: 200 });
const handle = await lock.acquire();
process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }));
await new Promise((resolve) => setTimeout(resolve, 25));
await handle.release();
