import { createCrossProcessLock } from "../../scripts/workbench/lock";

const lockPath = process.argv[2];
if (!lockPath) throw new Error("lock path required");
const lock = createCrossProcessLock(lockPath, { retryDelayMs: 5, maxAttempts: 200 });
const handle = await lock.acquire();
process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }));
await new Promise((resolve) => setTimeout(resolve, 25));
await handle.release();
