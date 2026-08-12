import { describe, expect, it } from "vitest";
import { capMetadata, createArtifactStore, encodeRequiredMetadata, encodeUtf8, orderOptionalEvidence, orderRetentionEvidence, orderTerminalRuns, rotateTextLog } from "../../scripts/workbench/artifacts";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REQUIRED_METADATA_RESERVATION_BYTES } from "../../scripts/workbench/contracts";

describe("workbench artifact retention", () => {
  it("sorts terminal runs by terminalAt and then runId", () => {
    expect(orderTerminalRuns([
      { runId: "b", terminalAt: 10 }, { runId: "a", terminalAt: 10 }, { runId: "c", terminalAt: 5 }
    ])).toEqual([{ runId: "c", terminalAt: 5 }, { runId: "a", terminalAt: 10 }, { runId: "b", terminalAt: 10 }]);
  });

  it("sorts optional evidence by capturedAt, runId, and relativePath", () => {
    expect(orderOptionalEvidence([
      { runId: "b", relativePath: "z", capturedAt: 1, category: "trace" },
      { runId: "a", relativePath: "z", capturedAt: 1, category: "trace" },
      { runId: "a", relativePath: "a", capturedAt: 1, category: "trace" }
    ])).toEqual([
      { runId: "a", relativePath: "a", capturedAt: 1, category: "trace" },
      { runId: "a", relativePath: "z", capturedAt: 1, category: "trace" },
      { runId: "b", relativePath: "z", capturedAt: 1, category: "trace" }
    ]);
  });

  it("rotates text logs at five MiB without evicting required metadata", () => {
    const result = rotateTextLog(new Uint8Array(5 * 1024 * 1024 + 10), 5 * 1024 * 1024);
    expect(result.byteLength).toBe(5 * 1024 * 1024);
  });

  it("caps metadata before encoding and retains bounded fields", () => {
    const capped = capMetadata({ scenario: "x".repeat(10_000), url: "u".repeat(30_000), screenshotPaths: Array.from({ length: 600 }, (_, i) => String(i)) });
    expect(encodeUtf8(JSON.stringify(capped)).byteLength).toBeGreaterThan(0);
    expect(capped.scenario).toHaveLength(4096);
    expect(capped.url).toHaveLength(16384);
    expect(capped.screenshotPaths).toHaveLength(500);
  });

  it("does not classify required metadata by a category word in its parent path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-artifacts-"));
    const run = path.join(root, "run-video-1");
    const store = createArtifactStore({ root: run, runId: "run-video-1", globalRoot: root, activeBudgetBytes: 20, globalBudgetBytes: 100 });
    await store.write("results.json", new Uint8Array(10), "result");
    await expect(store.write("screenshots/new.png", new Uint8Array(10), "screenshot")).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
    expect(await readFile(path.join(run, "results.json"))).toHaveLength(10);
    await rm(root, { recursive: true, force: true });
  });

  it("prunes terminal runs older than seven days before terminal count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-retention-"));
    for (let i = 0; i < 22; i += 1) {
      const run = path.join(root, `run-${String(i).padStart(2, "0")}`);
      await mkdir(run, { recursive: true });
      await writeFile(path.join(run, "status.json"), JSON.stringify({ status: "completed", terminalAt: i === 0 ? 1 : Date.now() - i * 1000 }));
      await writeFile(path.join(run, "results.json"), "required");
    }
    const store = createArtifactStore({ root: path.join(root, "run-new"), runId: "run-new", globalRoot: root });
    await store.write("results.json", new Uint8Array([1]), "result");
    expect((await readdir(root)).filter((entry) => entry.startsWith("run-")).length).toBeLessThanOrEqual(21);
    expect((await readdir(root)).filter((entry) => entry.startsWith("run-"))).not.toContain("run-00");
    await rm(root, { recursive: true, force: true });
  });

  it("replaces an oversized result with a minimal failure that fits both reservations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-overflow-"));
    const run = path.join(root, "run-1");
    const store = createArtifactStore({ root: run, runId: "run-1", globalRoot: root, activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 100, globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 100 });
    const huge = { runId: "run-1", buildPath: "build", profilePath: "profile", lease: { runId: "run-1", pid: 1, startedAt: "x", heartbeat: "x", profilePath: "profile", status: "active" }, cleanup: { profileRemoved: false }, commandRecords: Array.from({ length: 1000 }, () => "x".repeat(4096)) };
    await store.writeRequiredResult(huge);
    const parsed = JSON.parse(await readFile(path.join(run, "results.json"), "utf8"));
    expect(parsed.status).toBe("failed");
    expect(parsed.code).toBe("WORKBENCH_ARTIFACT_LIMIT");
    expect(new TextEncoder().encode(JSON.stringify(parsed)).byteLength).toBeLessThanOrEqual(REQUIRED_METADATA_RESERVATION_BYTES);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps at most twenty terminal runs including the affected run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-terminal-limit-"));
    for (let i = 0; i < 20; i += 1) {
      const run = path.join(root, `run-${String(i).padStart(2, "0")}`);
      await mkdir(run, { recursive: true });
      await writeFile(path.join(run, "status.json"), JSON.stringify({ status: "completed", terminalAt: Date.now() + i }));
      await writeFile(path.join(run, "results.json"), "required");
    }
    const target = path.join(root, "run-new");
    const store = createArtifactStore({ root: target, runId: "run-new", globalRoot: root });
    await store.write("results.json", new Uint8Array([1]), "result");
    await store.finalize("completed");
    const terminal = (await readdir(root)).filter((entry) => entry.startsWith("run-"));
    expect(terminal).toHaveLength(20);
    await rm(root, { recursive: true, force: true });
  });

  it("prunes optional evidence by video, trace, screenshot, then capturedAt and path", async () => {
    expect(orderRetentionEvidence([
      { runId: "a", relativePath: "s", capturedAt: 1, category: "screenshot" },
      { runId: "a", relativePath: "v", capturedAt: 30, category: "video" },
      { runId: "b", relativePath: "t", capturedAt: 20, category: "trace" }
    ]).map((item) => item.category)).toEqual(["video", "trace", "screenshot"]);
  });

  it("enforces store-level UTF-8 reservation boundaries and atomic overflow replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-boundaries-"));
    const run = path.join(root, "run-1");
    const budget = REQUIRED_METADATA_RESERVATION_BYTES + 4096;
    const store = createArtifactStore({ root: run, runId: "run-1", globalRoot: root, activeBudgetBytes: budget, globalBudgetBytes: budget });
    const make = (length: number) => ({ runId: "run-1", worktreePath: "worktree", buildPath: "build", profilePath: "profile", mode: "fixture", url: "url", scenario: "default", route: "groups", deepLink: "none", commandRecords: length ? Array.from({ length: 1000 }, () => "x".repeat(length)) : [], readiness: {}, screenshotPaths: [], assertions: [], lease: { runId: "run-1", pid: 1, startedAt: "x", heartbeat: "x", profilePath: "profile", status: "active" }, cleanup: { profileRemoved: false }, error: { message: "x" } });
    await store.writeRequiredResult(make(100));
    await store.writeRequiredResult(make(4096));
    const result = JSON.parse(await readFile(path.join(run, "results.json"), "utf8"));
    expect(result.status).toBe("failed");
    expect(result.code).toBe("WORKBENCH_ARTIFACT_LIMIT");
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(REQUIRED_METADATA_RESERVATION_BYTES);
    await rm(root, { recursive: true, force: true });
  });

  it("accepts required metadata at exact encoded size and rejects one byte below", async () => {
    const metadata = { runId: "run-1", commandRecords: Array.from({ length: 1000 }, () => ({ name: "x".repeat(2000) })) };
    const encoded = encodeRequiredMetadata(metadata);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-reservation-store-"));
    const below = createArtifactStore({ root: path.join(root, "below"), runId: "below", globalRoot: root, activeBudgetBytes: encoded.bytes.byteLength - 1, globalBudgetBytes: encoded.bytes.byteLength - 1 });
    await expect(below.writeRequiredResult(metadata)).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
    const exact = createArtifactStore({ root: path.join(root, "exact"), runId: "exact", globalRoot: root, activeBudgetBytes: encoded.bytes.byteLength, globalBudgetBytes: encoded.bytes.byteLength });
    await exact.writeRequiredResult(metadata);
    const plusRoot = await mkdtemp(path.join(os.tmpdir(), "tabroute-reservation-plus-"));
    const plus = createArtifactStore({ root: path.join(plusRoot, "plus"), runId: "plus", globalRoot: plusRoot, activeBudgetBytes: encoded.bytes.byteLength + 1, globalBudgetBytes: encoded.bytes.byteLength + 1 });
    await plus.writeRequiredResult(metadata);
    await rm(plusRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it("accounts lease, status, result, and error as one required reservation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-required-combined-"));
    const run = path.join(root, "run-1");
    const budget = REQUIRED_METADATA_RESERVATION_BYTES + 100;
    const store = createArtifactStore({ root: run, runId: "run-1", globalRoot: root, activeBudgetBytes: budget, globalBudgetBytes: budget });
    const half = new Uint8Array(Math.floor(REQUIRED_METADATA_RESERVATION_BYTES / 2));
    await store.write("lease.json", half, "lease");
    await expect(store.write("status.json", new Uint8Array(half.byteLength + 1), "status")).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
    await rm(root, { recursive: true, force: true });
  });

  it("leaves only the remaining required headroom for optional writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-required-headroom-"));
    const run = path.join(root, "run-1");
    const reservation = REQUIRED_METADATA_RESERVATION_BYTES;
    const store = createArtifactStore({ root: run, runId: "run-1", globalRoot: root, activeBudgetBytes: reservation + 100, globalBudgetBytes: reservation + 100 });
    await store.write("lease.json", new Uint8Array(reservation - 100), "lease");
    await store.write("trace/a.zip", new Uint8Array(50), "trace");
    await store.write("trace/b.zip", new Uint8Array(51), "trace");
    await expect(readFile(path.join(run, "trace", "b.zip"))).resolves.toHaveLength(51);
    await expect(readFile(path.join(run, "trace", "a.zip"))).rejects.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });

  it("uses each run's index when global pressure prunes optional evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-global-index-"));
    const first = createArtifactStore({ root: path.join(root, "run-a"), runId: "run-a", globalRoot: root, activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 1000, globalBudgetBytes: 400 });
    const second = createArtifactStore({ root: path.join(root, "run-b"), runId: "run-b", globalRoot: root, activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 1000, globalBudgetBytes: 400 });
    await first.write("video/a.webm", new Uint8Array(100), "video", { capturedAt: 1 });
    await second.write("trace/b.zip", new Uint8Array(100), "trace", { capturedAt: 2 });
    await second.write("trace/second.zip", new Uint8Array(100), "trace", { capturedAt: 2 });
    expect(await readFile(path.join(root, "run-a/video/a.webm")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(path.join(root, "run-b/trace/b.zip")).catch(() => undefined)).toBeTruthy();
    await rm(root, { recursive: true, force: true });
  });
});
