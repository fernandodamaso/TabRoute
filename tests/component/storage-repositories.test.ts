import { describe, expect, it } from "vitest";
import { createUuid } from "../../src/domain/ids";
import {
  createMemoryLocalRepository,
  LOCAL_SOFT_BUDGET_BYTES
} from "../../src/state/localRepository";
import { createActivityEntry } from "../../src/state/localRepository";

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
    expect(local.bags.snapshots.every((snapshot) => snapshot.kind === "named")).toBe(
      true
    );
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
});
