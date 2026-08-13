import { createUuid } from "../domain/ids";
import type {
  ActionId,
  BrowserSessionId,
  RuntimeSession,
  UndoPayload,
  UndoPlacement,
  UndoRecord
} from "../domain/types";
import { buildActionPlan } from "../actions/buildActionPlan";
import type { PlannedAction } from "../actions/types";

export function planUndoRestore(input: {
  payload: UndoPayload;
  session: RuntimeSession;
  now: number;
  undoTtlMs: number;
  browserSessionId: BrowserSessionId;
  actionId: ActionId;
}): UndoRecord {
  return {
    schemaVersion: 1,
    id: createUuid(),
    actionId: input.actionId,
    browserSessionId: input.browserSessionId,
    payloads: [input.payload],
    expiresAt: input.now + input.undoTtlMs,
    createdAt: input.now
  };
}

export const WINDOW_ID_NONE = -1;

export function planUndoActions(
  payload: UndoPayload,
  _placement: UndoPlacement,
  windowId: number | null
): ReturnType<typeof buildActionPlan> | { status: "unavailable" } {
  if (windowId === null || windowId === WINDOW_ID_NONE) {
    return { status: "unavailable" };
  }
  if (payload.kind === "restoreClosedTab") {
    const createId = createUuid() as unknown as ActionId;
    const create: PlannedAction = payload.sessionId
      ? {
          id: createId,
          dependsOn: [],
          kind: "restoreClosedTab",
          sessionId: payload.sessionId
        }
      : {
          id: createId,
          dependsOn: [],
          kind: "createTab",
          input: { url: payload.url, windowId, active: false }
        };
    return buildActionPlan("undo", [create], { requireCheckpoint: false });
  }
  return { status: "unavailable" };
}
