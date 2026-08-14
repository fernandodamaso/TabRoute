import type {
  ActionId,
  BrowserInventory,
  ShutdownCheckpoint
} from "../domain/types";
import type { LocalRepository } from "../state/localRepository";
import type { ActionPlan } from "../actions/types";
import { captureSnapshot, createCheckpointSnapshotId } from "./captureSnapshot";
import type { SnapshotContext } from "./captureSnapshot";
import { isDestructiveAction } from "../actions/buildActionPlan";

export interface PreMutationCheckpointPort {
  captureBefore(plan: ActionPlan, inventory: BrowserInventory): Promise<void>;
}

export function createPreMutationCheckpointService(input: {
  local: LocalRepository;
  captureContext: () => Promise<SnapshotContext>;
  now?: () => number;
}): PreMutationCheckpointPort {
  const now = input.now ?? (() => Date.now());
  return {
    async captureBefore(plan, inventory) {
      const destructive = plan.actions.some(isDestructiveAction);
      if (!destructive && plan.checkpoint !== "required") return;
      const context = await input.captureContext();
      const snapshot = captureSnapshot(
        { kind: "browser" },
        inventory,
        context,
        {
          id: createCheckpointSnapshotId(),
          name: "shutdown-latest",
          kind: "checkpoint",
          now: now()
        }
      );
      const checkpoint: ShutdownCheckpoint = {
        schemaVersion: 1,
        snapshot,
        capturedAt: now(),
        sourceActionId: plan.id as ActionId
      };
      const result = await input.local.saveShutdownCheckpoint(checkpoint);
      if (!result.ok) {
        throw new Error(
          result.code === "CHECKPOINT_CAPACITY"
            ? "CHECKPOINT_CAPACITY"
            : "CHECKPOINT_FAILED"
        );
      }
    }
  };
}

export { type SnapshotContext };
