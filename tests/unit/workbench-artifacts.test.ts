import { describe, expect, it } from "vitest";
import {
  capMetadata,
  createArtifactStore,
  encodeRequiredMetadata,
  encodeUtf8,
  orderOptionalEvidence,
  orderRetentionEvidence,
  orderTerminalRuns,
  rotateTextLog
} from "../../scripts/workbench/artifacts";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createArtifactLimitFailure,
  REQUIRED_METADATA_RESERVATION_BYTES,
  type ArtifactLimitSource,
  type RunResultStartedMetadata
} from "../../scripts/workbench/contracts";
import { LeaseManager } from "../../scripts/workbench/leases";
import { writeProductionGateResult } from "../../scripts/workbench/production-scan";

describe("workbench artifact retention", () => {
  it("keeps auxiliary outputs out of the lease-managed artifact root", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-auxiliary-artifacts-")
    );
    const worktree = path.join(root, "worktree");
    const artifactRoot = path.join(worktree, ".workbench", "artifacts");
    await mkdir(path.join(artifactRoot, "popup-run"), { recursive: true });
    await mkdir(path.join(artifactRoot, "preflight-run"), {
      recursive: true
    });
    const resultPath = await writeProductionGateResult(worktree, "gate-1", {
      graph: "production",
      workbenchBuildPath: "workbench",
      productionBuildPath: "production",
      productionScan: { ok: true }
    });
    expect(resultPath).toContain(path.join(".workbench", "artifacts"));
    const manager = new LeaseManager({
      artifactRoot,
      worktreePath: worktree,
      profileRoot: path.join(root, "profiles"),
      isProcessAlive: async () => true
    });
    await expect(manager.countActive()).resolves.toBe(0);
    await rm(root, { recursive: true, force: true });
  });
  it("sorts terminal runs by terminalAt and then runId", () => {
    expect(
      orderTerminalRuns([
        { runId: "b", terminalAt: 10 },
        { runId: "a", terminalAt: 10 },
        { runId: "c", terminalAt: 5 }
      ])
    ).toEqual([
      { runId: "c", terminalAt: 5 },
      { runId: "a", terminalAt: 10 },
      { runId: "b", terminalAt: 10 }
    ]);
  });

  it("sorts optional evidence by capturedAt, runId, and relativePath", () => {
    expect(
      orderOptionalEvidence([
        { runId: "b", relativePath: "z", capturedAt: 1, category: "trace" },
        { runId: "a", relativePath: "z", capturedAt: 1, category: "trace" },
        { runId: "a", relativePath: "a", capturedAt: 1, category: "trace" }
      ])
    ).toEqual([
      { runId: "a", relativePath: "a", capturedAt: 1, category: "trace" },
      { runId: "a", relativePath: "z", capturedAt: 1, category: "trace" },
      { runId: "b", relativePath: "z", capturedAt: 1, category: "trace" }
    ]);
  });

  it("rotates text logs at five MiB without evicting required metadata", () => {
    const result = rotateTextLog(
      new Uint8Array(5 * 1024 * 1024 + 10),
      5 * 1024 * 1024
    );
    expect(result.byteLength).toBe(5 * 1024 * 1024);
  });

  it("caps metadata before encoding and retains bounded fields", () => {
    const capped = capMetadata({
      scenario: "x".repeat(10_000),
      url: "u".repeat(30_000),
      screenshotPaths: Array.from({ length: 600 }, (_, i) => String(i))
    });
    expect(encodeUtf8(JSON.stringify(capped)).byteLength).toBeGreaterThan(0);
    expect(capped.scenario).toHaveLength(4096);
    expect(capped.url).toHaveLength(16384);
    expect(capped.screenshotPaths).toHaveLength(500);
  });

  it("does not classify required metadata by a category word in its parent path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-artifacts-"));
    const run = path.join(root, "run-video-1");
    const store = createArtifactStore({
      root: run,
      runId: "run-video-1",
      globalRoot: root,
      activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 20,
      globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 100
    });
    await store.write("results.json", new Uint8Array(10), "result");
    await expect(
      store.write("screenshots/new.png", new Uint8Array(10), "screenshot")
    ).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
    expect(await readFile(path.join(run, "results.json"))).toHaveLength(10);
    await rm(root, { recursive: true, force: true });
  });

  it("prunes terminal runs older than seven days before terminal count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-retention-"));
    for (let i = 0; i < 22; i += 1) {
      const run = path.join(root, `run-${String(i).padStart(2, "0")}`);
      await mkdir(run, { recursive: true });
      await writeFile(
        path.join(run, "status.json"),
        JSON.stringify({
          status: "completed",
          terminalAt: i === 0 ? 1 : Date.now() - i * 1000
        })
      );
      await writeFile(path.join(run, "results.json"), "required");
    }
    const store = createArtifactStore({
      root: path.join(root, "run-new"),
      runId: "run-new",
      globalRoot: root
    });
    await store.write("results.json", new Uint8Array([1]), "result");
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith("run-")).length
    ).toBeLessThanOrEqual(21);
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith("run-"))
    ).not.toContain("run-00");
    await rm(root, { recursive: true, force: true });
  });

  it("replaces an oversized result with a minimal failure that fits both reservations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-overflow-"));
    const run = path.join(root, "run-1");
    const store = createArtifactStore({
      root: run,
      runId: "run-1",
      globalRoot: root,
      activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 100,
      globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 100
    });
    const huge = {
      runId: "run-1",
      worktreePath: "worktree",
      buildPath: "build",
      profilePath: "profile",
      lease: {
        runId: "run-1",
        pid: 1,
        startedAt: "x",
        heartbeat: "x",
        profilePath: "profile",
        status: "active" as const
      },
      cleanup: { profileRemoved: false },
      commandRecords: Array.from({ length: 1000 }, () => "x".repeat(4096))
    } satisfies ArtifactLimitSource & Record<string, unknown>;
    await store.writeRequiredResult(huge);
    const parsed = JSON.parse(
      await readFile(path.join(run, "results.json"), "utf8")
    );
    expect(parsed.status).toBe("failed");
    expect(parsed.code).toBe("WORKBENCH_ARTIFACT_LIMIT");
    expect(
      new TextEncoder().encode(JSON.stringify(parsed)).byteLength
    ).toBeLessThanOrEqual(REQUIRED_METADATA_RESERVATION_BYTES);
    await rm(root, { recursive: true, force: true });
  });

  it("publishes a bounded failure when the full result fits alone but not with existing required metadata", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-combined-overflow-")
    );
    const run = path.join(root, "run-1");
    const metadata: RunResultStartedMetadata & {
      lease: RunResultStartedMetadata["lease"] & { status: "active" };
    } = {
      status: "failed",
      runId: "run-1",
      worktreePath: "worktree",
      buildPath: "build",
      profilePath: "profile",
      mode: "fixture",
      url: "url",
      scenario: "default",
      route: "groups",
      deepLink: "none",
      commandRecords: Array.from({ length: 10 }, (_, index) => ({
        recordType: "event" as const,
        mode: "fixture" as const,
        source: "page" as const,
        at: index,
        name: `event-${index}`,
        details: {}
      })),
      readiness: {},
      screenshotPaths: [],
      assertions: [],
      lease: {
        runId: "run-1",
        pid: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        heartbeat: "2026-01-01T00:00:00.000Z",
        profilePath: "profile",
        status: "active"
      },
      cleanup: { profileRemoved: false }
    };
    const minimal = encodeUtf8(
      JSON.stringify(
        createArtifactLimitFailure(metadata, {
          message: "required metadata exceeds reserved artifact space"
        })
      )
    );
    const full = encodeRequiredMetadata(metadata);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.bytes.byteLength).toBeGreaterThan(minimal.byteLength);
    const store = createArtifactStore({
      root: run,
      runId: "run-1",
      globalRoot: root,
      activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES,
      globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES
    });
    await store.write(
      "lease.json",
      new Uint8Array(REQUIRED_METADATA_RESERVATION_BYTES - minimal.byteLength),
      "lease"
    );
    await store.writeRequiredResult(metadata);
    expect(
      JSON.parse(await readFile(path.join(run, "results.json"), "utf8"))
    ).toMatchObject({ code: "WORKBENCH_ARTIFACT_LIMIT", phase: "artifact" });
    await rm(root, { recursive: true, force: true });
  });

  it("keeps at most twenty terminal runs including the affected run", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-terminal-limit-")
    );
    for (let i = 0; i < 20; i += 1) {
      const run = path.join(root, `run-${String(i).padStart(2, "0")}`);
      await mkdir(run, { recursive: true });
      await writeFile(
        path.join(run, "status.json"),
        JSON.stringify({ status: "completed", terminalAt: Date.now() + i })
      );
      await writeFile(path.join(run, "results.json"), "required");
    }
    const target = path.join(root, "run-new");
    const store = createArtifactStore({
      root: target,
      runId: "run-new",
      globalRoot: root
    });
    await store.write("results.json", new Uint8Array([1]), "result");
    await store.finalize("completed");
    const terminal = (await readdir(root)).filter((entry) =>
      entry.startsWith("run-")
    );
    expect(terminal).toHaveLength(20);
    await rm(root, { recursive: true, force: true });
  });

  it("prunes optional evidence by video, trace, screenshot, then capturedAt and path", async () => {
    expect(
      orderRetentionEvidence([
        {
          runId: "a",
          relativePath: "s",
          capturedAt: 1,
          category: "screenshot"
        },
        { runId: "a", relativePath: "v", capturedAt: 30, category: "video" },
        { runId: "b", relativePath: "t", capturedAt: 20, category: "trace" }
      ]).map((item) => item.category)
    ).toEqual(["video", "trace", "screenshot"]);
  });

  it("enforces store-level UTF-8 reservation boundaries and atomic overflow replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-boundaries-"));
    const run = path.join(root, "run-1");
    const budget = REQUIRED_METADATA_RESERVATION_BYTES + 4096;
    const store = createArtifactStore({
      root: run,
      runId: "run-1",
      globalRoot: root,
      activeBudgetBytes: budget,
      globalBudgetBytes: budget
    });
    const make = (length: number) => ({
      runId: "run-1",
      worktreePath: "worktree",
      buildPath: "build",
      profilePath: "profile",
      mode: "fixture",
      url: "url",
      scenario: "default",
      route: "groups",
      deepLink: "none",
      commandRecords: length
        ? Array.from({ length: 1000 }, () => "x".repeat(length))
        : [],
      readiness: {},
      screenshotPaths: [],
      assertions: [],
      lease: {
        runId: "run-1",
        pid: 1,
        startedAt: "x",
        heartbeat: "x",
        profilePath: "profile",
        status: "active" as const
      },
      cleanup: { profileRemoved: false },
      error: { message: "x" }
    });
    await store.writeRequiredResult(make(100));
    await store.writeRequiredResult(make(4096));
    const result = JSON.parse(
      await readFile(path.join(run, "results.json"), "utf8")
    );
    expect(result.status).toBe("failed");
    expect(result.code).toBe("WORKBENCH_ARTIFACT_LIMIT");
    expect(
      new TextEncoder().encode(JSON.stringify(result)).byteLength
    ).toBeLessThanOrEqual(REQUIRED_METADATA_RESERVATION_BYTES);
    await rm(root, { recursive: true, force: true });
  });

  it("accepts required metadata at exact encoded size and rejects one byte below", async () => {
    const metadata = {
      runId: "run-1",
      worktreePath: "worktree",
      buildPath: "build",
      profilePath: "profile",
      lease: {
        runId: "run-1",
        pid: 1,
        startedAt: "x",
        heartbeat: "x",
        profilePath: "profile",
        status: "active" as const
      },
      cleanup: { profileRemoved: false },
      commandRecords: Array.from({ length: 1000 }, () => ({
        name: "x".repeat(2000)
      }))
    } satisfies ArtifactLimitSource & Record<string, unknown>;
    const encoded = encodeRequiredMetadata(metadata);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-reservation-store-")
    );
    const below = createArtifactStore({
      root: path.join(root, "below"),
      runId: "below",
      globalRoot: root,
      activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES - 1,
      globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES - 1
    });
    await expect(below.writeRequiredResult(metadata)).rejects.toThrow(
      "WORKBENCH_ARTIFACT_LIMIT"
    );
    const exact = createArtifactStore({
      root: path.join(root, "exact"),
      runId: "exact",
      globalRoot: root,
      activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES,
      globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES
    });
    await exact.writeRequiredResult(metadata);
    const plusRoot = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-reservation-plus-")
    );
    const plus = createArtifactStore({
      root: path.join(plusRoot, "plus"),
      runId: "plus",
      globalRoot: plusRoot,
      activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 1,
      globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 1
    });
    await plus.writeRequiredResult(metadata);
    await rm(plusRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it("accounts lease, status, result, and error as one required reservation", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-required-combined-")
    );
    const run = path.join(root, "run-1");
    const budget = REQUIRED_METADATA_RESERVATION_BYTES + 100;
    const store = createArtifactStore({
      root: run,
      runId: "run-1",
      globalRoot: root,
      activeBudgetBytes: budget,
      globalBudgetBytes: budget
    });
    const half = new Uint8Array(
      Math.floor(REQUIRED_METADATA_RESERVATION_BYTES / 2)
    );
    await store.write("lease.json", half, "lease");
    await expect(
      store.write("status.json", new Uint8Array(half.byteLength + 1), "status")
    ).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
    await rm(root, { recursive: true, force: true });
  });

  it("enforces affected-run required bytes at minus, exact, and plus boundaries", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-affected-boundary-")
    );
    try {
      const minus = createArtifactStore({
        root: path.join(root, "minus"),
        runId: "minus",
        globalRoot: path.join(root, "minus"),
        activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES - 1,
        globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES - 1
      });
      await expect(
        minus.write(
          "lease.json",
          new Uint8Array(REQUIRED_METADATA_RESERVATION_BYTES - 1),
          "lease"
        )
      ).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
      const exact = createArtifactStore({
        root: path.join(root, "exact"),
        runId: "exact",
        globalRoot: path.join(root, "exact"),
        activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES,
        globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES
      });
      await exact.write(
        "lease.json",
        new Uint8Array(REQUIRED_METADATA_RESERVATION_BYTES - 1),
        "lease"
      );
      await exact.write("status.json", new Uint8Array(1), "status");
      const plus = createArtifactStore({
        root: path.join(root, "plus"),
        runId: "plus",
        globalRoot: path.join(root, "plus"),
        activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 1,
        globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 1
      });
      await plus.write(
        "lease.json",
        new Uint8Array(REQUIRED_METADATA_RESERVATION_BYTES),
        "lease"
      );
      await expect(
        plus.write("status.json", new Uint8Array(1), "status")
      ).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps separate required reservations for multiple runs in the global budget", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-global-boundary-")
    );
    try {
      const first = createArtifactStore({
        root: path.join(root, "run-a"),
        runId: "run-a",
        globalRoot: root,
        activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 100,
        globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES * 2
      });
      const second = createArtifactStore({
        root: path.join(root, "run-b"),
        runId: "run-b",
        globalRoot: root,
        activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 100,
        globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES * 2
      });
      await first.write(
        "lease.json",
        new Uint8Array(REQUIRED_METADATA_RESERVATION_BYTES - 1),
        "lease"
      );
      await second.write("lease.json", new Uint8Array(1), "lease");
      await first.write("results.json", new Uint8Array(1), "result");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves only the remaining required headroom for optional writes", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-required-headroom-")
    );
    const run = path.join(root, "run-1");
    const reservation = REQUIRED_METADATA_RESERVATION_BYTES;
    const store = createArtifactStore({
      root: run,
      runId: "run-1",
      globalRoot: root,
      activeBudgetBytes: reservation + 200,
      globalBudgetBytes: reservation + 200
    });
    await store.write("lease.json", new Uint8Array(reservation - 100), "lease");
    await store.write("trace/a.zip", new Uint8Array(50), "trace");
    await store.write("trace/b.zip", new Uint8Array(51), "trace");
    await expect(
      readFile(path.join(run, "trace", "b.zip"))
    ).resolves.toHaveLength(51);
    await expect(
      readFile(path.join(run, "trace", "a.zip"))
    ).rejects.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });

  it("does not treat nested required-looking names as root required metadata", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-nested-required-")
    );
    const store = createArtifactStore({
      root: path.join(root, "run-1"),
      runId: "run-1",
      globalRoot: root,
      activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES,
      globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES
    });
    await expect(
      store.write("nested/results.json", new Uint8Array(1), "result", {
        capturedAt: 1
      })
    ).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
    await rm(root, { recursive: true, force: true });
  });

  it("preserves exact required headroom at affected optional-write boundaries", async () => {
    const payloadBytes = 7;
    const indexBytes = encodeUtf8(
      JSON.stringify([
        { relativePath: "trace/a.zip", kind: "trace", capturedAt: 1 }
      ])
    ).byteLength;
    for (const delta of [-1, 0, 1]) {
      const root = await mkdtemp(
        path.join(os.tmpdir(), `tabroute-affected-optional-${delta}-`)
      );
      const run = path.join(root, "run-1");
      const store = createArtifactStore({
        root: run,
        runId: "run-1",
        globalRoot: root,
        activeBudgetBytes:
          REQUIRED_METADATA_RESERVATION_BYTES +
          payloadBytes +
          indexBytes +
          delta,
        globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES * 2
      });
      const write = store.write(
        "trace/a.zip",
        new Uint8Array(payloadBytes),
        "trace",
        { capturedAt: 1 }
      );
      if (delta < 0)
        await expect(write).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
      else await expect(write).resolves.toBeUndefined();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves exact required headroom at global optional-write boundaries", async () => {
    const payloadBytes = 7;
    const indexBytes = encodeUtf8(
      JSON.stringify([
        { relativePath: "trace/a.zip", kind: "trace", capturedAt: 1 }
      ])
    ).byteLength;
    for (const delta of [-1, 0, 1]) {
      const root = await mkdtemp(
        path.join(os.tmpdir(), `tabroute-global-optional-${delta}-`)
      );
      const run = path.join(root, "run-1");
      const store = createArtifactStore({
        root: run,
        runId: "run-1",
        globalRoot: root,
        activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES * 2,
        globalBudgetBytes:
          REQUIRED_METADATA_RESERVATION_BYTES +
          payloadBytes +
          indexBytes +
          delta
      });
      const write = store.write(
        "trace/a.zip",
        new Uint8Array(payloadBytes),
        "trace",
        { capturedAt: 1 }
      );
      if (delta < 0)
        await expect(write).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
      else await expect(write).resolves.toBeUndefined();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves global headroom for every active run when logs cannot be pruned", async () => {
    const payloadBytes = 7;
    const indexBytes = encodeUtf8(
      JSON.stringify([
        { relativePath: "worker.log", kind: "log", capturedAt: 1 }
      ])
    ).byteLength;
    for (const delta of [-1, 0]) {
      const root = await mkdtemp(
        path.join(os.tmpdir(), `tabroute-global-active-${delta}-`)
      );
      const budget =
        REQUIRED_METADATA_RESERVATION_BYTES * 2 +
        payloadBytes +
        indexBytes +
        delta;
      const first = createArtifactStore({
        root: path.join(root, "run-a"),
        runId: "run-a",
        globalRoot: root,
        activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES * 2,
        globalBudgetBytes: budget
      });
      const second = createArtifactStore({
        root: path.join(root, "run-b"),
        runId: "run-b",
        globalRoot: root,
        activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES * 2,
        globalBudgetBytes: budget
      });
      await first.write("worker.log", new Uint8Array(payloadBytes), "log", {
        capturedAt: 1
      });
      const write = second.write(
        "lease.json",
        new Uint8Array(REQUIRED_METADATA_RESERVATION_BYTES),
        "lease"
      );
      if (delta < 0)
        await expect(write).rejects.toThrow("WORKBENCH_ARTIFACT_LIMIT");
      else await expect(write).resolves.toBeUndefined();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses each run's index when global pressure prunes optional evidence", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tabroute-global-index-")
    );
    const first = createArtifactStore({
      root: path.join(root, "run-a"),
      runId: "run-a",
      globalRoot: root,
      activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 1000,
      globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES * 2 + 400
    });
    const second = createArtifactStore({
      root: path.join(root, "run-b"),
      runId: "run-b",
      globalRoot: root,
      activeBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES + 1000,
      globalBudgetBytes: REQUIRED_METADATA_RESERVATION_BYTES * 2 + 400
    });
    await first.write("video/a.webm", new Uint8Array(100), "video", {
      capturedAt: 1
    });
    await second.write("trace/b.zip", new Uint8Array(100), "trace", {
      capturedAt: 2
    });
    await second.write("trace/second.zip", new Uint8Array(100), "trace", {
      capturedAt: 2
    });
    expect(
      await readFile(path.join(root, "run-a/video/a.webm")).catch(
        () => undefined
      )
    ).toBeUndefined();
    expect(
      await readFile(path.join(root, "run-b/trace/b.zip")).catch(
        () => undefined
      )
    ).toBeTruthy();
    await rm(root, { recursive: true, force: true });
  });
});
