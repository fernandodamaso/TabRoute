import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExtension, resolveBuildOutput } from "../../scripts/workbench/build";
import {
  canonicalExtensionUrl,
  createChromiumLaunchOptions,
  parseExtensionWorkerUrl,
  recordWorkerGeneration
} from "../../scripts/workbench/browser";
import {
  MANAGER_QUERY_TIMEOUT_MS,
  MANAGER_RETRY_INTERVAL_MS,
  WORKER_DISCOVERY_TIMEOUT_MS,
  isReceivingEndStartupRace,
  settleManagerQuery
} from "../../scripts/workbench/readiness";
import { formatRetainedResultPath } from "../../scripts/workbench/results";
import { runCleanup } from "../../scripts/workbench/runner";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workbench build isolation", () => {
  it("creates graph-specific output under the current worktree and never .output", () => {
    const worktree = path.resolve("C:/repo/TabRoute");
    expect(resolveBuildOutput(worktree, "run-a", "workbench")).toEqual({
      graph: "workbench",
      outDir: path.join(worktree, ".workbench", "tmp", "run-a", "workbench"),
      buildPath: path.join(worktree, ".workbench", "tmp", "run-a", "workbench", "chrome-mv3")
    });
    expect(resolveBuildOutput(worktree, "run-b", "production").buildPath).not.toContain(".output");
  });

  it("refuses to build a checkout other than process.cwd()", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "tabroute-other-worktree-"));
    temporary.push(other);
    await expect(buildExtension({ worktreePath: other, runId: "run-a", graph: "workbench" }))
      .rejects.toThrow("WORKBENCH_ARGUMENT");
  });
});

describe("Chromium extension lifecycle contracts", () => {
  it("derives the extension ID from a validated service-worker URL", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    expect(parseExtensionWorkerUrl(`chrome-extension://${id}/background.js`)).toBe(id);
    expect(() => parseExtensionWorkerUrl(`https://${id}/background.js`)).toThrow("WORKBENCH_ARGUMENT");
    expect(() => parseExtensionWorkerUrl("chrome-extension://fixed/background.js")).toThrow("WORKBENCH_ARGUMENT");
  });

  it("launches bundled Chromium headlessly with only the run build loaded", () => {
    const buildPath = path.resolve("C:/repo/.workbench/tmp/run-a/workbench/chrome-mv3");
    expect(createChromiumLaunchOptions(buildPath, true)).toEqual({
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${buildPath}`, `--load-extension=${buildPath}`]
    });
  });

  it("keeps worker discovery and first manager query on separate deadlines", () => {
    expect(WORKER_DISCOVERY_TIMEOUT_MS).toBe(15_000);
    expect(MANAGER_QUERY_TIMEOUT_MS).toBe(5_000);
    expect(MANAGER_RETRY_INTERVAL_MS).toBe(250);
  });

  it("retries only the receiving-end startup race at 250 ms cadence", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce({ ok: true });

    await expect(settleManagerQuery({
      request,
      now: () => now,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; }
    })).resolves.toEqual({ response: { ok: true }, settledAt: 250 });
    expect(sleeps).toEqual([250]);
    expect(isReceivingEndStartupRace(new Error("RECEIVING END DOES NOT EXIST"))).toBe(true);
    expect(isReceivingEndStartupRace(new Error("connection closed"))).toBe(false);
  });

  it("does not extend the manager-query deadline when the receiving-end race persists", async () => {
    let now = 0;
    const request = vi.fn().mockRejectedValue(new Error("Receiving end does not exist"));
    await expect(settleManagerQuery({
      request,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; }
    })).rejects.toThrow("first manager query did not settle before the deadline");
    expect(now).toBe(MANAGER_QUERY_TIMEOUT_MS);
  });

  it("does not retry any other manager error", async () => {
    const request = vi.fn().mockRejectedValue(new Error("connection closed"));
    await expect(settleManagerQuery({ request })).rejects.toThrow("connection closed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("builds the canonical default fixture URL from the discovered ID", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    expect(canonicalExtensionUrl(id, "options.html", "fixture")).toBe(
      `chrome-extension://${id}/options.html?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none`
    );
  });

  it("records distinct worker target generations", () => {
    const generations: Array<{ id: string; discoveredAt: string }> = [];
    recordWorkerGeneration(generations, "target-1", "2026-08-13T00:00:00.000Z");
    recordWorkerGeneration(generations, "target-2", "2026-08-13T00:00:01.000Z");
    recordWorkerGeneration(generations, "target-2", "2026-08-13T00:00:02.000Z");
    expect(generations).toEqual([
      { id: "target-1", discoveredAt: "2026-08-13T00:00:00.000Z" },
      { id: "target-2", discoveredAt: "2026-08-13T00:00:01.000Z" }
    ]);
  });
});

describe("runner cleanup evidence", () => {
  it("always closes the session and removes the owned profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-runner-cleanup-"));
    temporary.push(root);
    const profile = path.join(root, "profile-run-a");
    await mkdir(profile);
    const close = vi.fn().mockResolvedValue(undefined);
    await expect(runCleanup({ close, profilePath: profile, profileRoot: root, runId: "run-a", worktreePath: process.cwd() }))
      .resolves.toEqual({ profileRemoved: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("retains and reports the profile when cleanup exhausts its retries", async () => {
    const sleeps: number[] = [];
    const remove = vi.fn().mockRejectedValue(new Error("profile busy"));
    await expect(runCleanup({
      close: vi.fn().mockResolvedValue(undefined),
      profilePath: path.join(os.tmpdir(), "tabroute-workbench", "run-a"),
      profileRoot: path.join(os.tmpdir(), "tabroute-workbench"),
      runId: "run-a",
      worktreePath: process.cwd(),
      remove,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); }
    })).resolves.toEqual({ profileRemoved: false, retainedPath: path.join(os.tmpdir(), "tabroute-workbench", "run-a"), error: "profile busy" });
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  it("prints the retained result path as one stable line", () => {
    expect(formatRetainedResultPath(path.resolve("C:/repo/.workbench/artifacts/run-a/results.json")))
      .toBe(`Workbench result: ${path.resolve("C:/repo/.workbench/artifacts/run-a/results.json")}`);
  });
});
