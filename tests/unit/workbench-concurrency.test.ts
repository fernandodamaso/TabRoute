import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCrossProcessLock } from "../../scripts/workbench/lock";

describe("workbench cross-process lock", () => {
  const runWorker = (args: string[]) => new Promise<string>((resolve, reject) => {
    const helper = path.resolve("tests/helpers/workbench-lock-worker.ts");
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
    const child = spawn(process.execPath, [tsx, helper, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { errorOutput += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`worker exited ${code}: ${errorOutput}`)));
  });
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

  it("allows exactly one of two real contenders to create lease eight", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tabroute-capacity-"));
    const artifactRoot = path.join(directory, "artifacts");
    await mkdir(artifactRoot, { recursive: true });
    for (let i = 0; i < 7; i += 1) {
      const run = path.join(artifactRoot, `seed-${i}`);
      await mkdir(run, { recursive: true });
      await writeFile(path.join(run, "lease.json"), JSON.stringify({ runId: `seed-${i}`, pid: process.pid, startedAt: new Date().toISOString(), heartbeat: new Date().toISOString(), profilePath: path.join(directory, "seed-profiles", `seed-${i}`), status: "active" }));
    }
    const helper = path.resolve("tests/helpers/workbench-lock-worker.ts");
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
    const run = (runId: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [tsx, helper, artifactRoot, "lease", runId, directory], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`worker exited ${code}`)));
    });
    try {
      const results = (await Promise.all([run("contender-a"), run("contender-b")])).map((value) => JSON.parse(value));
      expect(results.filter((value) => value.ok === true)).toHaveLength(1);
      expect(results.filter((value) => value.code === "WORKBENCH_CAPACITY")).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not remove a replacement lock after stale ownership revalidation", async () => {
    const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "tabroute-stale-race-")), ".lock");
    await (await import("node:fs/promises")).writeFile(lockPath, JSON.stringify({ pid: 7, runId: "old", heartbeat: 0, token: "old-token" }));
    let replacement = false;
    const lock = createCrossProcessLock(lockPath, { now: () => 20 * 60 * 1000, isPidAlive: async () => false, retryDelayMs: 1, maxAttempts: 1, beforeStaleRemove: async () => { await (await import("node:fs/promises")).writeFile(lockPath, JSON.stringify({ pid: 8, runId: "new", heartbeat: 20 * 60 * 1000, token: "new-token" })); replacement = true; } });
    await expect(lock.acquire()).rejects.toMatchObject({ code: "WORKBENCH_CAPACITY" });
    expect(replacement).toBe(true);
    expect(JSON.parse(await (await import("node:fs/promises")).readFile(lockPath, "utf8")).token).toBe("new-token");
  });

  it("does not overwrite a replacement lock during heartbeat refresh", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tabroute-heartbeat-race-"));
    const lockPath = path.join(directory, ".lock");
    let heartbeat!: () => void;
    let replaced = false;
    const lock = createCrossProcessLock(lockPath, {
      runId: "old", setInterval: ((callback: () => void) => { heartbeat = callback; return 1 as unknown as NodeJS.Timeout; }) as never, clearInterval: (() => undefined) as never,
      beforeHeartbeatReplace: async () => { if (!replaced) { replaced = true; await (await import("node:fs/promises")).writeFile(lockPath, JSON.stringify({ pid: 8, runId: "new", heartbeat: Date.now(), token: "new-token" })); } }
    });
    const handle = await lock.acquire();
    heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(JSON.parse(await (await import("node:fs/promises")).readFile(lockPath, "utf8")).token).toBe("new-token");
    await handle.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps a live lock name present and parseable through heartbeat, release, and reacquire", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tabroute-heartbeat-live-"));
    const lockPath = path.join(directory, ".lock");
    let heartbeat!: () => void;
    let observedPresent = false;
    const lock = createCrossProcessLock(lockPath, {
      runId: "owner", setInterval: ((callback: () => void) => { heartbeat = callback; return 1 as unknown as NodeJS.Timeout; }) as never,
      clearInterval: (() => undefined) as never,
      beforeHeartbeatReplace: async () => { await access(lockPath); observedPresent = true; }
    });
    const handle = await lock.acquire();
    heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const raw = await readFile(lockPath, "utf8");
    expect(observedPresent).toBe(true);
    expect(raw.startsWith("\0")).toBe(false);
    expect(JSON.parse(raw).runId).toBe("owner");
    await handle.release();
    const reacquired = await lock.acquire();
    await reacquired.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("opens the post-validation stale window without deleting a newly acquired owner", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tabroute-stale-window-"));
    const lockPath = path.join(directory, ".lock");
    await (await import("node:fs/promises")).writeFile(lockPath, JSON.stringify({ pid: 7, runId: "old", heartbeat: 0, token: "old-token" }));
    let windowEntered = false;
    const lock = createCrossProcessLock(lockPath, { now: () => 20 * 60 * 1000, isPidAlive: async () => false, retryDelayMs: 1, maxAttempts: 1, beforeStaleRemove: async () => { windowEntered = true; await (await import("node:fs/promises")).rm(lockPath, { force: true }); await (await import("node:fs/promises")).writeFile(lockPath, JSON.stringify({ pid: 8, runId: "new", heartbeat: 20 * 60 * 1000, token: "new-token" })); } });
    await expect(lock.acquire()).rejects.toMatchObject({ code: "WORKBENCH_CAPACITY" });
    expect(windowEntered).toBe(true);
    expect(JSON.parse(await (await import("node:fs/promises")).readFile(lockPath, "utf8")).token).toBe("new-token");
    await rm(directory, { recursive: true, force: true });
  });

  it("serializes real artifact writes and prunes in one deterministic order", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tabroute-artifact-process-"));
      const budget = 650;
    try {
      for (const runId of ["seed-a", "seed-b", "seed-c"]) {
        await mkdir(path.join(directory, runId), { recursive: true });
        await writeFile(path.join(directory, runId, "lease.json"), "{}" );
        await writeFile(path.join(directory, runId, "status.json"), "{}" );
        await writeFile(path.join(directory, runId, "results.json"), "{}" );
        await writeFile(path.join(directory, runId, "error.json"), "{}" );
        await mkdir(path.join(directory, runId, "trace"), { recursive: true });
        await writeFile(path.join(directory, runId, "trace", "seed.zip"), new Uint8Array(100));
        await writeFile(path.join(directory, runId, ".artifact-index.json"), JSON.stringify([{ relativePath: "trace/seed.zip", kind: "trace", capturedAt: Number(runId.at(-1)) }]))
      }
      const results = await Promise.all([
        runWorker([directory, "artifact", "contender-a", "trace/a.zip", "10", String(budget)]),
        runWorker([directory, "artifact", "contender-b", "trace/b.zip", "11", String(budget)])
      ]);
      expect(results.every((value) => JSON.parse(value).ok)).toBe(true);
      await expect(access(path.join(directory, "seed-a", "trace", "seed.zip"))).rejects.toBeDefined();
      await expect(readFile(path.join(directory, "seed-b", "lease.json"))).resolves.toBeTruthy();
      await expect(readFile(path.join(directory, "seed-b", "status.json"))).resolves.toBeTruthy();
      await expect(readFile(path.join(directory, "seed-b", "results.json"))).resolves.toBeTruthy();
      await expect(readFile(path.join(directory, "seed-b", "error.json"))).resolves.toBeTruthy();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("serializes real concurrent orphan reaping with one clean result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tabroute-reap-process-"));
    const artifactRoot = path.join(directory, "artifacts");
    const profileRoot = path.join(directory, "profiles");
    const worktreePath = path.join(directory, "worktree");
    const profile = path.join(profileRoot, "run-1");
    try {
      await mkdir(path.join(artifactRoot, "run-1"), { recursive: true });
      await mkdir(profile, { recursive: true });
      const lease = { runId: "run-1", pid: 999999, startedAt: "2020-01-01T00:00:00.000Z", heartbeat: "2020-01-01T00:00:00.000Z", profilePath: profile, status: "active" };
      const result = { ok: false, status: "failed", code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker", runId: "run-1", worktreePath, buildPath: "build", profilePath: profile, mode: "fixture", url: "url", scenario: "default", route: "groups", deepLink: "none", commandRecords: [], readiness: {}, screenshotPaths: [], assertions: [], lease, cleanup: { profileRemoved: false }, error: { message: "old" } };
      await writeFile(path.join(artifactRoot, "run-1", "lease.json"), JSON.stringify(lease));
      await writeFile(path.join(artifactRoot, "run-1", "results.json"), JSON.stringify(result));
      const outputs = await Promise.all([runWorker([artifactRoot, "reap", worktreePath, profileRoot]), runWorker([artifactRoot, "reap", worktreePath, profileRoot])]);
      expect(outputs.filter((value) => JSON.parse(value).length === 1)).toHaveLength(1);
      expect(outputs.filter((value) => JSON.parse(value).length === 0)).toHaveLength(1);
      const persisted = JSON.parse(await readFile(path.join(artifactRoot, "run-1", "results.json"), "utf8"));
      expect(persisted).toMatchObject({ ok: true, status: "abandoned", cleanup: { profileRemoved: true } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
