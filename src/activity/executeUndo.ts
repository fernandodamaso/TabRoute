import {
  executeActionPlan,
  type ActionEngineDeps
} from "../actions/executeActionPlan";
import type { Configuration, UUID } from "../domain/types";
import type { LocalRepository } from "../state/localRepository";
import type { SessionRepository } from "../state/sessionRepository";
import {
  planUndoActions,
  undoPlanIsDegraded,
  WINDOW_ID_NONE
} from "./undoPlanner";

export type UndoExecutionResult =
  "success" | "expired" | "unavailable" | "degraded";

export async function executeUndo(input: {
  undoId: UUID;
  local: LocalRepository;
  session: SessionRepository;
  deps: ActionEngineDeps;
  configuration: Configuration;
  now: () => number;
}): Promise<UndoExecutionResult> {
  const record = await input.local.getUndo(input.undoId);
  if (!record) return "unavailable";
  const runtime = await input.session.loadSession();
  if (record.browserSessionId !== runtime.browserSessionId)
    return "unavailable";
  if (record.expiresAt <= input.now()) return "expired";

  const payload = record.payloads[0];
  if (!payload) return "unavailable";

  const inventory = await input.deps.reads.readInventory();
  const focusedId = await input.deps.reads.getLastFocusedNormalWindowId();
  const normalWindow =
    inventory.windows.find(
      (window) =>
        !window.incognito &&
        window.type === "normal" &&
        (focusedId === null || focusedId === WINDOW_ID_NONE
          ? true
          : window.id === focusedId)
    ) ??
    inventory.windows.find(
      (window) => !window.incognito && window.type === "normal"
    );
  const windowId = normalWindow?.id ?? null;
  if (windowId === null || windowId === WINDOW_ID_NONE) return "unavailable";

  const degradedBeforeExecute =
    payload.kind === "restoreClosedTab" || payload.kind === "restorePlacement"
      ? undoPlanIsDegraded(
          payload,
          windowId,
          input.configuration,
          inventory,
          runtime.associations
        )
      : false;

  const planResult = planUndoActions({
    payload,
    windowId,
    configuration: input.configuration,
    inventory,
    associations: runtime.associations
  });
  if ("status" in planResult) return "unavailable";

  const result = await executeActionPlan(planResult, {
    ...input.deps,
    configuration: input.configuration
  });
  if (result.status === "failure") return "degraded";
  await input.local.deleteUndo(input.undoId);
  return degradedBeforeExecute ? "degraded" : "success";
}
