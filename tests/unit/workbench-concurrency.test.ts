import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCrossProcessLock } from "../../scripts/workbench/lock";

describe("workbench cross-process lock", () => {
  it("serializes concurrent operations on one lock path", async () => {
    const lockPath = `${process.cwd()}/.vitest-workbench-lock-${process.pid}`;
    const first = createCrossProcessLock(lockPath, { retryDelayMs: 1, maxAttempts: 20 });
    const second = createCrossProcessLock(lockPath, { retryDelayMs: 1, maxAttempts: 20 });
    const release = await first.acquire();
    let entered = false;
    const waiting = second.withLock(async () => { entered = true; return "done"; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(entered).toBe(false);
    await release.release();
    expect(await waiting).toBe("done");
  });

  it("serializes two real Node contenders through the lock worker", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tabroute-lock-"));
    const lockPath = path.join(directory, ".lock");
    const helper = path.resolve("tests/helpers/workbench-lock-worker.ts");
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [tsx, helper, lockPath], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`worker exited ${code}`)));
    });
    try {
      const outputs = await Promise.all([run(), run()]);
      expect(outputs.every((output) => JSON.parse(output).ok === true)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
