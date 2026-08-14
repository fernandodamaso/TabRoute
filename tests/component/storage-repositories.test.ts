import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createUuid } from "../../src/domain/ids";
import {
  createChromeLocalRepository,
  createMemoryLocalRepository,
  LOCAL_SOFT_BUDGET_BYTES,
  createActivityEntry
} from "../../src/state/localRepository";
import { STORAGE_KEYS } from "../../src/state/keys";
import { createConfigurationSyncCoordinator } from "../../src/state/configurationSyncCoordinator";

describe("storage repositories", () => {
  it("prunes expired undo before automatic snapshots and activity", async () => {
    const now = 10_000;
    const local = createMemoryLocalRepository({
      undo: {
        expired: {
          schemaVersion: 1,
          id: createUuid(),
          actionId: createUuid() as never,
          browserSessionId: "session" as never,
          payloads: [],
          expiresAt: now - 1,
          createdAt: 1
        }
      },
      snapshots: [
        {
          schemaVersion: 1,
          id: createUuid(),
          name: "auto",
          kind: "automatic",
          scope: { kind: "browser" },
          groups: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      activity: [
        createActivityEntry({
          action: "old",
          result: "success",
          affectedManagedGroupIds: [],
          affectedUrls: [],
          createdAt: 1
        })
      ]
    });
    const result = await local.saveShutdownCheckpoint({
      schemaVersion: 1,
      snapshot: {
        schemaVersion: 1,
        id: createUuid(),
        name: "checkpoint",
        kind: "checkpoint",
        scope: { kind: "browser" },
        groups: [],
        createdAt: now,
        updatedAt: now
      },
      capturedAt: now
    });
    expect(result.ok).toBe(true);
    expect(local.bags.undo.expired).toBeUndefined();
    expect(Object.keys(local.bags.undo)).toHaveLength(0);
  });
  it("durably hydrates and writes every pruned Local bag before checkpoint publication", async () => {
    const now = 10_000;
    const stored: Record<string, unknown> = {
      [STORAGE_KEYS.localSnapshots]: [
        {
          schemaVersion: 1,
          id: createUuid(),
          name: "x".repeat(LOCAL_SOFT_BUDGET_BYTES),
          kind: "automatic",
          scope: { kind: "browser" },
          groups: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      [STORAGE_KEYS.localActivity]: [
        createActivityEntry({
          action: "x".repeat(LOCAL_SOFT_BUDGET_BYTES),
          result: "success",
          affectedManagedGroupIds: [],
          affectedUrls: [],
          createdAt: 1
        })
      ],
      [STORAGE_KEYS.localUndo]: {
        expired: {
          schemaVersion: 1,
          id: createUuid(),
          actionId: createUuid() as never,
          browserSessionId: "session" as never,
          payloads: [],
          expiresAt: now - 1,
          createdAt: 1
        }
      },
      [STORAGE_KEYS.localWindowOwnership]: {},
      [STORAGE_KEYS.localShutdownCheckpoint]: null
    };
    const area = {
      async get(key?: string | readonly string[]) {
        if (!key) return { ...stored };
        const keys = typeof key === "string" ? [key] : key;
        return Object.fromEntries(keys.map((item) => [item, stored[item]]));
      },
      async set(values: Record<string, unknown>) {
        Object.assign(stored, values);
      },
      async remove() {}
    };
    const local = createChromeLocalRepository(area, area, area);
    const checkpoint = {
      schemaVersion: 1 as const,
      snapshot: {
        schemaVersion: 1 as const,
        id: createUuid(),
        name: "checkpoint",
        kind: "checkpoint" as const,
        scope: { kind: "browser" as const },
        groups: [],
        createdAt: now,
        updatedAt: now
      },
      capturedAt: now
    };
    const result = await local.saveShutdownCheckpoint(checkpoint);
    expect(result.ok).toBe(true);
    expect(stored[STORAGE_KEYS.localSnapshots]).toEqual([]);
    expect(stored[STORAGE_KEYS.localActivity]).toEqual([]);
    expect(stored[STORAGE_KEYS.localUndo]).toEqual({});
    expect(stored[STORAGE_KEYS.localShutdownCheckpoint]).toEqual(checkpoint);
  });

  it("named snapshots are never auto-deleted", async () => {
    const local = createMemoryLocalRepository({
      snapshots: Array.from({ length: 50 }, (_, index) => ({
        schemaVersion: 1 as const,
        id: createUuid(),
        name: `named-${index}`,
        kind: "named" as const,
        scope: { kind: "browser" as const },
        groups: [],
        createdAt: index,
        updatedAt: index
      }))
    });
    const result = await local.saveSnapshot({
      schemaVersion: 1,
      id: createUuid(),
      name: "extra",
      kind: "named",
      scope: { kind: "browser" },
      groups: [],
      createdAt: 100,
      updatedAt: 100
    });
    expect(result.ok).toBe(false);
    expect(
      local.bags.snapshots.every((snapshot) => snapshot.kind === "named")
    ).toBe(true);
  });

  it("returns CHECKPOINT_CAPACITY when checkpoint cannot fit after pruning", async () => {
    const local = createMemoryLocalRepository();
    const oversized = {
      schemaVersion: 1 as const,
      snapshot: {
        schemaVersion: 1 as const,
        id: createUuid(),
        name: "x".repeat(LOCAL_SOFT_BUDGET_BYTES),
        kind: "checkpoint" as const,
        scope: { kind: "browser" as const },
        groups: [],
        createdAt: 1,
        updatedAt: 1
      },
      capturedAt: 1
    };
    const result = await local.saveShutdownCheckpoint(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CHECKPOINT_CAPACITY");
  });

  it("incomplete remote generation does not append success activity", async () => {
    const local = createMemoryLocalRepository();
    const { recordSyncRevisionActivity } =
      await import("../../src/activity/activityRepository");
    await recordSyncRevisionActivity(local, { kind: "pending" }, 1);
    expect(await local.listActivity(undefined, 10)).toHaveLength(0);

    await recordSyncRevisionActivity(local, { kind: "applied" }, 2);
    const entries = await local.listActivity(undefined, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe("success");
  });

  it("records invalid remote sync as a local activity failure via coordinator", async () => {
    const local = createMemoryLocalRepository();
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000099"
    );
    const coordinator = createConfigurationSyncCoordinator({
      repository: {
        async applySyncChange() {
          return {
            kind: "invalid" as const,
            configuration,
            reason: "checksum mismatch"
          };
        },
        async markControllerRevisionApplied() {}
      },
      callbacks: {
        async replaceConfiguration() {},
        async refreshMenus() {},
        async refreshAlarms() {},
        async refreshViews() {},
        async scheduleRetry() {}
      },
      recordSyncActivity: { local, now: () => 1000 }
    });

    await coordinator.applySyncChange(["config:v1:head"]);

    const entries = await local.listActivity(undefined, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe("failure");
    expect(entries[0]?.errorCode).toBe("checksum mismatch");
  });
  it("serializes concurrent Chrome Local snapshot mutations through promise tail queue", async () => {
    const stored: Record<string, unknown> = {
      [STORAGE_KEYS.localSnapshots]: []
    };

    let pauseSetPromise: Promise<void> | null = null;
    let resolveSetPromise: (() => void) | null = null;

    const area = {
      async get(key?: string | readonly string[]) {
        if (!key) return { ...stored };
        const keys = typeof key === "string" ? [key] : key;
        return Object.fromEntries(keys.map((item) => [item, stored[item]]));
      },
      async set(values: Record<string, unknown>) {
        if (pauseSetPromise && STORAGE_KEYS.localSnapshots in values) {
          await pauseSetPromise;
        }
        Object.assign(stored, values);
      },
      async remove() {}
    };

    const local = createChromeLocalRepository(area, area, area);
    const snap1 = {
      schemaVersion: 1 as const,
      id: createUuid(),
      name: "snap-1",
      kind: "named" as const,
      scope: { kind: "browser" as const },
      groups: [],
      createdAt: 1,
      updatedAt: 1
    };
    const snap2 = {
      schemaVersion: 1 as const,
      id: createUuid(),
      name: "snap-2",
      kind: "automatic" as const,
      scope: { kind: "browser" as const },
      groups: [],
      createdAt: 2,
      updatedAt: 2
    };

    pauseSetPromise = new Promise<void>((resolve) => {
      resolveSetPromise = resolve;
    });

    const p1 = local.saveSnapshot(snap1);
    const p2 = local.saveSnapshot(snap2);

    // Unpause first set
    resolveSetPromise!();

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    const saved = await local.listSnapshots();
    expect(saved).toHaveLength(2);
    expect(saved.map((s) => s.name).sort()).toEqual(["snap-1", "snap-2"]);
  });

  it("checkpoint vs activity serialized read-modify-write does not overwrite bags", async () => {
    const stored: Record<string, unknown> = {};
    const area = {
      async get(key?: string | readonly string[]) {
        if (!key) return { ...stored };
        const keys = typeof key === "string" ? [key] : key;
        return Object.fromEntries(keys.map((item) => [item, stored[item]]));
      },
      async set(values: Record<string, unknown>) {
        Object.assign(stored, values);
      },
      async remove() {}
    };

    const local = createChromeLocalRepository(area, area, area);
    const checkpoint = {
      schemaVersion: 1 as const,
      snapshot: {
        schemaVersion: 1 as const,
        id: createUuid(),
        name: "checkpoint",
        kind: "checkpoint" as const,
        scope: { kind: "browser" as const },
        groups: [],
        createdAt: 10,
        updatedAt: 10
      },
      capturedAt: 10
    };
    const activity = createActivityEntry({
      action: "test-action",
      result: "success",
      affectedManagedGroupIds: [],
      affectedUrls: [],
      createdAt: 10
    });

    await Promise.all([
      local.saveShutdownCheckpoint(checkpoint),
      local.appendActivity(activity)
    ]);

    expect(await local.loadShutdownCheckpoint()).toEqual(checkpoint);
    expect(await local.listActivity(undefined, 10)).toHaveLength(1);
  });

  it("reports real Sync item diagnostics with multibyte UTF-8 characters", async () => {
    const { storageItemBytes } =
      await import("../../src/state/configurationShards");
    const syncStored: Record<string, unknown> = {
      "key:emoji:🚀": "value:世界:🌍",
      "key:plain": { a: 1, b: "hello" }
    };
    const syncArea = {
      async get() {
        return { ...syncStored };
      },
      async set() {},
      async remove() {},
      async getBytesInUse() {
        return 1234;
      }
    };
    const localArea = {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
      async getBytesInUse() {
        return 5678;
      }
    };
    const sessionArea = {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
      async getBytesInUse() {
        return 90;
      }
    };

    const local = createChromeLocalRepository(localArea, syncArea, sessionArea);
    const diag = await local.getStorageDiagnostics();

    expect(diag.syncItemCount).toBe(2);
    expect(diag.syncBytes).toBe(1234);

    const expectedBytes1 = storageItemBytes("key:emoji:🚀", "value:世界:🌍");
    const expectedBytes2 = storageItemBytes("key:plain", { a: 1, b: "hello" });
    const expectedLargest = Math.max(expectedBytes1, expectedBytes2);

    expect(diag.syncLargestItemBytes).toBe(expectedLargest);
  });
});
