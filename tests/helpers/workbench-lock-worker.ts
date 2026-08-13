import { createCrossProcessLock } from "../../scripts/workbench/lock";
import { LeaseManager } from "../../scripts/workbench/leases";
import { createArtifactStore } from "../../scripts/workbench/artifacts";

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
if (process.argv[3] === "artifact") {
  const runId = process.argv[4] ?? `run-${process.pid}`;
  const relativePath = process.argv[5] ?? `trace/${runId}.zip`;
  const capturedAt = Number(process.argv[6] ?? Date.now());
  const budget = Number(process.argv[7] ?? 50 * 1024 * 1024);
  const store = createArtifactStore({ root: `${lockPath}/${runId}`, runId, globalRoot: lockPath, activeBudgetBytes: budget, globalBudgetBytes: budget });
  await store.write(relativePath, new Uint8Array(50), "trace", { capturedAt });
  process.stdout.write(JSON.stringify({ ok: true, runId, relativePath }));
  process.exit(0);
}
if (process.argv[3] === "reap") {
  const worktreePath = process.argv[4] ?? process.cwd();
  const profileRoot = process.argv[5] ?? `${worktreePath}-profiles`;
  const manager = new LeaseManager({ artifactRoot: lockPath, worktreePath, profileRoot, isProcessAlive: async () => false });
  process.stdout.write(JSON.stringify(await manager.reapOrphans()));
  process.exit(0);
}
const lock = createCrossProcessLock(lockPath, { retryDelayMs: 5, maxAttempts: 200 });
const handle = await lock.acquire();
process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }));
await new Promise((resolve) => setTimeout(resolve, 25));
await handle.release();
