import { createUuid } from "../domain/ids";
import { renderGroupTitle } from "../groups/displayTitle";
import { buildActionPlan } from "../actions/buildActionPlan";
import type { ActionPlan, PlannedAction } from "../actions/types";
import type {
  ActionId,
  BrowserSessionId,
  ChromeInventory,
  Configuration,
  RuntimeSession,
  UndoPayload,
  UndoPlacement,
  UndoRecord
} from "../domain/types";

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

type ResolvedUndoPlacement =
  | {
      kind: "managedGroup";
      managedGroupId: import("../domain/types").UUID;
      windowId: number;
      index: number;
      degraded: boolean;
    }
  | { kind: "ungrouped"; windowId: number; index: number; degraded: boolean }
  | {
      kind: "unmanagedGroup";
      chromeGroupId: number;
      windowId: number;
      index: number;
      degraded: boolean;
    };

export function resolveUndoPlacement(
  placement: UndoPlacement,
  windowId: number,
  configuration: Configuration,
  inventory: ChromeInventory
): ResolvedUndoPlacement {
  if (placement.kind === "managedGroup") {
    const targetWindow = placement.windowIdHint ?? windowId;
    const group = configuration.groups.find(
      (candidate) => candidate.id === placement.managedGroupId
    );
    return {
      kind: "managedGroup",
      managedGroupId: placement.managedGroupId,
      windowId: targetWindow,
      index: placement.index,
      degraded: !group
    };
  }
  if (placement.kind === "ungrouped") {
    const targetWindow = placement.windowIdHint ?? windowId;
    const windowExists = inventory.windows.some(
      (candidate) =>
        candidate.id === targetWindow &&
        !candidate.incognito &&
        candidate.type === "normal"
    );
    return {
      kind: "ungrouped",
      windowId: windowExists ? targetWindow : windowId,
      index: placement.index,
      degraded: placement.windowIdHint !== undefined && !windowExists
    };
  }
  const groupExists = inventory.groups.some(
    (candidate) =>
      candidate.id === placement.chromeGroupIdHint &&
      candidate.windowId === placement.windowIdHint &&
      !candidate.shared
  );
  if (!groupExists) {
    const windowExists = inventory.windows.some(
      (candidate) =>
        candidate.id === placement.windowIdHint &&
        !candidate.incognito &&
        candidate.type === "normal"
    );
    return {
      kind: "ungrouped",
      windowId: windowExists ? placement.windowIdHint : windowId,
      index: placement.index,
      degraded: true
    };
  }
  return {
    kind: "unmanagedGroup",
    chromeGroupId: placement.chromeGroupIdHint,
    windowId: placement.windowIdHint,
    index: placement.index,
    degraded: false
  };
}

function appendPlacementActions(
  actions: PlannedAction[],
  createId: ActionId,
  resolved: ResolvedUndoPlacement,
  configuration: Configuration
): { actions: PlannedAction[]; degraded: boolean } {
  let lastId = createId;
  let degraded = resolved.degraded;

  function push(action: PlannedAction) {
    actions.push(action);
    lastId = action.id;
  }

  if (resolved.kind === "managedGroup") {
    const group = configuration.groups.find(
      (candidate) => candidate.id === resolved.managedGroupId
    );
    if (!group) {
      degraded = true;
      push({
        id: createUuid() as unknown as ActionId,
        dependsOn: [lastId],
        kind: "moveTabs",
        tabs: [{ kind: "actionOutput", actionId: createId }],
        windowId: resolved.windowId,
        index: resolved.index
      });
      return { actions, degraded };
    }
    push({
      id: createUuid() as unknown as ActionId,
      dependsOn: [lastId],
      kind: "assignTabsToManagedGroup",
      tabs: [{ kind: "actionOutput", actionId: createId }],
      managedGroupId: resolved.managedGroupId,
      windowId: resolved.windowId,
      title: renderGroupTitle(group),
      color: group.color
    });
    return { actions, degraded };
  }

  if (resolved.kind === "unmanagedGroup") {
    push({
      id: createUuid() as unknown as ActionId,
      dependsOn: [lastId],
      kind: "assignTabsToUnmanagedGroup",
      tabs: [{ kind: "actionOutput", actionId: createId }],
      chromeGroupId: resolved.chromeGroupId,
      windowId: resolved.windowId
    });
    push({
      id: createUuid() as unknown as ActionId,
      dependsOn: [lastId],
      kind: "moveTabs",
      tabs: [{ kind: "actionOutput", actionId: createId }],
      windowId: resolved.windowId,
      index: resolved.index
    });
    return { actions, degraded };
  }

  push({
    id: createUuid() as unknown as ActionId,
    dependsOn: [lastId],
    kind: "moveTabs",
    tabs: [{ kind: "actionOutput", actionId: createId }],
    windowId: resolved.windowId,
    index: resolved.index
  });
  return { actions, degraded };
}

export function planUndoActions(input: {
  payload: UndoPayload;
  windowId: number;
  configuration: Configuration;
  inventory: ChromeInventory;
}): ActionPlan | { status: "unavailable" } {
  if (input.windowId === WINDOW_ID_NONE) {
    return { status: "unavailable" };
  }
  const normalWindow = input.inventory.windows.some(
    (window) => !window.incognito && window.type === "normal"
  );
  if (!normalWindow) return { status: "unavailable" };

  if (input.payload.kind === "restoreClosedTab") {
    const createId = createUuid() as unknown as ActionId;
    const create: PlannedAction = input.payload.sessionId
      ? {
          id: createId,
          dependsOn: [],
          kind: "restoreClosedTab",
          sessionId: input.payload.sessionId
        }
      : {
          id: createId,
          dependsOn: [],
          kind: "createTab",
          input: {
            url: input.payload.url,
            windowId: input.windowId,
            active: false
          }
        };
    const resolved = resolveUndoPlacement(
      input.payload.placement,
      input.windowId,
      input.configuration,
      input.inventory
    );
    const placed = appendPlacementActions(
      [create],
      createId,
      resolved,
      input.configuration
    );
    return buildActionPlan("undo", placed.actions, { requireCheckpoint: false });
  }

  if (input.payload.kind === "restorePlacement") {
    return { status: "unavailable" };
  }

  return { status: "unavailable" };
}

export function undoPlanIsDegraded(
  payload: UndoPayload,
  windowId: number,
  configuration: Configuration,
  inventory: ChromeInventory
): boolean {
  if (payload.kind !== "restoreClosedTab" && payload.kind !== "restorePlacement") {
    return false;
  }
  return resolveUndoPlacement(payload.placement, windowId, configuration, inventory)
    .degraded;
}
