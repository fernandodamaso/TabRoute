import { describe, expect, it, vi } from "vitest";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import {
  createMemoryLocalRepository,
  LOCAL_SOFT_BUDGET_BYTES
} from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createUuid } from "../../src/domain/ids";
import {
  restoreSnapshotFromRecord,
  saveNamedSnapshot
} from "../../src/snapshots/snapshotService";
import type { Snapshot, UUID } from "../../src/domain/types";
import { observeInventory } from "../../src/duplicates/observations";

function namedSnapshot(
  configuration: ReturnType<typeof createDefaultConfiguration>,
  id: UUID,
  name: string
): Snapshot {
  return {
    schemaVersion: 1,
    id,
    name,
    kind: "named",
    scope: { kind: "browser" },
    groups: [
      {
        managedGroupId: configuration.fallbackGroupId,
        name: "Other",
        color: "grey",
        collapsed: false,
        order: 0,
        tabs: [
          {
            url: "https://example.com/",
            title: "Example",
            duplicateKey: "https://example.com/",
            order: 0
          }
        ]
      }
    ],
    createdAt: 1,
    updatedAt: 1
  };
}

describe("snapshot restore component", () => {
  it("restores with 50 named snapshots present", async () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const snapshotId = createUuid();
    const local = createMemoryLocalRepository({
      snapshots: [
        ...Array.from({ length: 50 }, (_, index) => ({
          schemaVersion: 1 as const,
          id: createUuid(),
          name: `named-${index}`,
          kind: "named" as const,
          scope: { kind: "browser" as const },
          groups: [],
          createdAt: index,
          updatedAt: index
        })),
        namedSnapshot(configuration, snapshotId, "restore-me")
      ]
    });
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    const session = createMemorySessionRepository();
    const result = await restoreSnapshotFromRecord({
      local,
      session,
      snapshotId,
      actionDeps: {
        reads: fake,
        mutations: fake,
        checkpoints: {
          async captureBefore() {
            return undefined;
          }
        },
        local,
        session,
        configuration,
        now: () => 1,
        delay: async () => undefined
      }
    });
    expect(result.ok).toBe(true);
    expect(fake.callsFor("createTab").length).toBeGreaterThan(0);
  });

  it("blocks restore with CHECKPOINT_CAPACITY and zero mutations", async () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const snapshotId = createUuid();
    const local = createMemoryLocalRepository({
      snapshots: [namedSnapshot(configuration, snapshotId, "restore-me")]
    });
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    const session = createMemorySessionRepository();
    const originalEstimate = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementation((value) => {
      if (
        typeof value === "object" &&
        value &&
        "snapshot" in (value as object)
      ) {
        return "x".repeat(LOCAL_SOFT_BUDGET_BYTES + 1);
      }
      return originalEstimate(value);
    });
    const result = await restoreSnapshotFromRecord({
      local,
      session,
      snapshotId,
      actionDeps: {
        reads: fake,
        mutations: fake,
        checkpoints: {
          async captureBefore(plan, inventory) {
            const { createPreMutationCheckpointService } =
              await import("../../src/snapshots/checkpointService");
            await createPreMutationCheckpointService({
              local,
              captureContext: async () => ({
                configuration,
                ownership: {},
                associations: []
              })
            }).captureBefore(plan, inventory);
          }
        },
        local,
        session,
        configuration,
        now: () => 1,
        delay: async () => undefined
      }
    });
    vi.restoreAllMocks();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("CHECKPOINT_FAILED");
    expect(fake.callsFor("createTab")).toEqual([]);
  });

  it("named save at 50 with automatic present deletes oldest automatic", async () => {
    const configuration = createDefaultConfiguration(() => createUuid());
    const automaticId = createUuid();
    const local = createMemoryLocalRepository({
      snapshots: [
        ...Array.from({ length: 49 }, (_, index) => ({
          schemaVersion: 1 as const,
          id: createUuid(),
          name: `named-${index}`,
          kind: "named" as const,
          scope: { kind: "browser" as const },
          groups: [],
          createdAt: index,
          updatedAt: index
        })),
        {
          schemaVersion: 1,
          id: automaticId,
          name: "auto-old",
          kind: "automatic",
          scope: { kind: "browser" },
          groups: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    });
    const raw = {
      windows: [
        {
          id: 1,
          focused: true,
          incognito: false as const,
          type: "normal" as const
        }
      ],
      tabs: [],
      groups: [],
      capturedAt: 1
    };
    const session = await createMemorySessionRepository().loadSession();
    const { inventory } = observeInventory(raw, session);
    const result = await saveNamedSnapshot({
      local,
      name: "fiftieth",
      scope: { kind: "browser" },
      inventory,
      context: { configuration, ownership: {}, associations: [] }
    });
    expect(result.ok).toBe(true);
    const snapshots = await local.listSnapshots();
    expect(snapshots.some((snapshot) => snapshot.id === automaticId)).toBe(
      false
    );
    expect(
      snapshots.filter((snapshot) => snapshot.kind === "named")
    ).toHaveLength(50);
  });
});
