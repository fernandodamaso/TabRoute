import { describe, expect, it, vi } from "vitest";
import { createUuid } from "../../src/domain/ids";
import {
  createMemoryLocalRepository,
  LOCAL_SOFT_BUDGET_BYTES
} from "../../src/state/localRepository";
import { createPreMutationCheckpointService } from "../../src/snapshots/checkpointService";
import { buildActionPlan } from "../../src/actions/buildActionPlan";
import type { ActionId } from "../../src/domain/types";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { observeInventory } from "../../src/duplicates/observations";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";

describe("checkpoint service", () => {
  it("finishes the checkpoint before releasing a destructive plan", async () => {
    const local = createMemoryLocalRepository();
    const configuration = createDefaultConfiguration(() => createUuid());
    const checkpoint = createPreMutationCheckpointService({
      local,
      captureContext: async () => ({
        configuration,
        ownership: {},
        associations: []
      })
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
    const plan = buildActionPlan("reconcile", [
      {
        id: createUuid() as unknown as ActionId,
        dependsOn: [],
        kind: "closeDuplicate",
        duplicate: { kind: "live", tabId: 2 },
        survivor: { kind: "live", tabId: 1 }
      }
    ]);
    await checkpoint.captureBefore(plan, inventory);
    expect(await local.loadShutdownCheckpoint()).not.toBeNull();
  });

  it("rejects CHECKPOINT_FAILED before any mutation", async () => {
    const local = createMemoryLocalRepository();
    Object.defineProperty(local.bags, "snapshots", {
      value: [
        {
          schemaVersion: 1,
          id: createUuid(),
          name: "big",
          kind: "automatic",
          scope: { kind: "browser" },
          groups: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      writable: true
    });
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
    const configuration = createDefaultConfiguration(() => createUuid());
    const checkpoint = createPreMutationCheckpointService({
      local,
      captureContext: async () => ({
        configuration,
        ownership: {},
        associations: []
      })
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
    const plan = buildActionPlan("reconcile", [
      {
        id: createUuid() as unknown as ActionId,
        dependsOn: [],
        kind: "closeDuplicate",
        duplicate: { kind: "live", tabId: 2 },
        survivor: { kind: "live", tabId: 1 }
      }
    ]);
    await expect(checkpoint.captureBefore(plan, inventory)).rejects.toThrow(
      /CHECKPOINT_CAPACITY/
    );
    vi.restoreAllMocks();
  });
});
