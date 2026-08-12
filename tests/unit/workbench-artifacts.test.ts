import { describe, expect, it } from "vitest";
import { capMetadata, createArtifactStore, encodeUtf8, orderOptionalEvidence, orderTerminalRuns, rotateTextLog } from "../../scripts/workbench/artifacts";
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
});
