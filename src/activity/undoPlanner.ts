import { isRoutableUrl } from "../chrome/types";
import { createUuid } from "../domain/ids";
import { renderGroupTitle } from "../groups/displayTitle";
import { buildActionPlan } from "../actions/buildActionPlan";
import type { ActionPlan, PlannedAction, TabRef } from "../actions/types";
import type {
  ActionId,
  BrowserSessionId,
  ChromeAssociation,
  ChromeInventory,
  ChromeTabSnapshot,
  Configuration,
  RuntimeSession,
  TabSnapshot,
  UndoPayload,
  UndoPlacement,
  UndoRecord,
  UUID
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
      managedGroupId: UUID;
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

function isNormalWindow(inventory: ChromeInventory, windowId: number): boolean {
  return inventory.windows.some(
    (candidate) =>
      candidate.id === windowId &&
      !candidate.incognito &&
      candidate.type === "normal"
  );
}

function managedGroupHomeWindow(
  managedGroupId: UUID,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): number | null {
  for (const association of associations) {
    if (association.managedGroupId !== managedGroupId) continue;
    const group = inventory.groups.find(
      (candidate) =>
        candidate.id === association.chromeGroupId &&
        candidate.windowId === association.chromeWindowId &&
        !candidate.shared
    );
    if (group && isNormalWindow(inventory, association.chromeWindowId)) {
      return association.chromeWindowId;
    }
  }
  return null;
}

function resolveManagedGroupPlacement(
  placement: Extract<UndoPlacement, { kind: "managedGroup" }>,
  fallbackWindowId: number,
  configuration: Configuration,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): Extract<ResolvedUndoPlacement, { kind: "managedGroup" }> {
  const originalGroup = configuration.groups.find(
    (candidate) => candidate.id === placement.managedGroupId
  );
  let managedGroupId = placement.managedGroupId;
  let degraded = !originalGroup;

  if (!originalGroup) {
    managedGroupId = configuration.fallbackGroupId;
  }

  let windowId = fallbackWindowId;
  if (
    placement.windowIdHint !== undefined &&
    isNormalWindow(inventory, placement.windowIdHint)
  ) {
    windowId = placement.windowIdHint;
  } else {
    if (placement.windowIdHint !== undefined) degraded = true;
    const homeWindow = managedGroupHomeWindow(
      managedGroupId,
      inventory,
      associations
    );
    if (homeWindow !== null) {
      windowId = homeWindow;
    } else if (originalGroup) {
      managedGroupId = configuration.fallbackGroupId;
      degraded = true;
      windowId = fallbackWindowId;
    }
  }

  return {
    kind: "managedGroup",
    managedGroupId,
    windowId,
    index: placement.index,
    degraded
  };
}

export function deriveUndoPlacementFromTab(
  tab: Pick<TabSnapshot, "windowId" | "index" | "chromeGroupId">,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): UndoPlacement {
  if (tab.chromeGroupId < 0) {
    return { kind: "ungrouped", windowIdHint: tab.windowId, index: tab.index };
  }
  const group = inventory.groups.find(
    (candidate) => candidate.id === tab.chromeGroupId
  );
  const association = associations.find(
    (candidate) =>
      candidate.chromeGroupId === tab.chromeGroupId &&
      candidate.chromeWindowId === tab.windowId
  );
  if (association && !group?.shared) {
    return {
      kind: "managedGroup",
      managedGroupId: association.managedGroupId,
      windowIdHint: tab.windowId,
      index: tab.index
    };
  }
  return {
    kind: "unmanagedGroup",
    chromeGroupIdHint: tab.chromeGroupId,
    windowIdHint: tab.windowId,
    index: tab.index
  };
}

export function resolveUndoPlacement(
  placement: UndoPlacement,
  windowId: number,
  configuration: Configuration,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[] = []
): ResolvedUndoPlacement {
  if (placement.kind === "managedGroup") {
    return resolveManagedGroupPlacement(
      placement,
      windowId,
      configuration,
      inventory,
      associations
    );
  }
  if (placement.kind === "ungrouped") {
    const targetWindow = placement.windowIdHint ?? windowId;
    const windowExists = isNormalWindow(inventory, targetWindow);
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
    const windowExists = isNormalWindow(inventory, placement.windowIdHint);
    if (!windowExists) {
      return {
        kind: "managedGroup",
        managedGroupId: configuration.fallbackGroupId,
        windowId,
        index: placement.index,
        degraded: true
      };
    }
    return {
      kind: "ungrouped",
      windowId: placement.windowIdHint,
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
      const fallback = configuration.groups.find(
        (candidate) => candidate.id === configuration.fallbackGroupId
      );
      if (!fallback) {
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
        managedGroupId: configuration.fallbackGroupId,
        windowId: resolved.windowId,
        title: renderGroupTitle(fallback),
        color: fallback.color
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
      kind: "assignTabsToManagedGroup",
      tabs: [{ kind: "actionOutput", actionId: createId }],
      managedGroupId: resolved.managedGroupId,
      windowId: resolved.windowId,
      title: renderGroupTitle(group),
      color: group.color
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

function buildLivePlacementActions(
  tab: ChromeTabSnapshot,
  resolved: ResolvedUndoPlacement,
  configuration: Configuration
): PlannedAction[] {
  const actions: PlannedAction[] = [];
  const ref: TabRef = { kind: "live", tabId: tab.id };
  let lastId: ActionId | undefined;

  function dependencies(): ActionId[] {
    return lastId ? [lastId] : [];
  }

  function push(action: PlannedAction) {
    actions.push(action);
    lastId = action.id;
  }

  if (resolved.kind === "ungrouped") {
    if (tab.chromeGroupId >= 0) {
      push({
        id: createUuid() as unknown as ActionId,
        dependsOn: [],
        kind: "ungroupTabs",
        tabs: [ref]
      });
    }
    push({
      id: createUuid() as unknown as ActionId,
      dependsOn: dependencies(),
      kind: "moveTabs",
      tabs: [ref],
      windowId: resolved.windowId,
      index: resolved.index
    });
    return actions;
  }

  if (tab.windowId !== resolved.windowId) {
    push({
      id: createUuid() as unknown as ActionId,
      dependsOn: [],
      kind: "moveTabs",
      tabs: [ref],
      windowId: resolved.windowId,
      index: -1
    });
  }

  if (resolved.kind === "managedGroup") {
    const group = configuration.groups.find(
      (candidate) => candidate.id === resolved.managedGroupId
    );
    if (!group) return [];
    push({
      id: createUuid() as unknown as ActionId,
      dependsOn: dependencies(),
      kind: "assignTabsToManagedGroup",
      tabs: [ref],
      managedGroupId: group.id,
      windowId: resolved.windowId,
      title: renderGroupTitle(group),
      color: group.color
    });
  } else {
    push({
      id: createUuid() as unknown as ActionId,
      dependsOn: dependencies(),
      kind: "assignTabsToUnmanagedGroup",
      tabs: [ref],
      chromeGroupId: resolved.chromeGroupId,
      windowId: resolved.windowId
    });
  }

  push({
    id: createUuid() as unknown as ActionId,
    dependsOn: dependencies(),
    kind: "moveTabs",
    tabs: [ref],
    windowId: resolved.windowId,
    index: resolved.index
  });
  return actions;
}

export function planUndoActions(input: {
  payload: UndoPayload;
  windowId: number;
  configuration: Configuration;
  inventory: ChromeInventory;
  associations?: readonly ChromeAssociation[];
}): ActionPlan | { status: "unavailable" } {
  if (input.windowId === WINDOW_ID_NONE) {
    return { status: "unavailable" };
  }
  const normalWindow = input.inventory.windows.some(
    (window) => !window.incognito && window.type === "normal"
  );
  if (!normalWindow) return { status: "unavailable" };

  const associations = input.associations ?? [];

  if (input.payload.kind === "restoreClosedTab") {
    const createId = createUuid() as unknown as ActionId;
    const create: PlannedAction = input.payload.sessionId
      ? {
          id: createId,
          dependsOn: [],
          kind: "restoreClosedTab",
          sessionId: input.payload.sessionId,
          expectedUrl: input.payload.url,
          windowId: input.windowId
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
      input.inventory,
      associations
    );
    const placed = appendPlacementActions(
      [create],
      createId,
      resolved,
      input.configuration
    );
    return buildActionPlan("undo", placed.actions, {
      requireCheckpoint: false
    });
  }

  if (input.payload.kind === "restorePlacement") {
    const payload = input.payload;
    const tab = input.inventory.tabs.find(
      (candidate) => candidate.id === payload.tabId
    );
    if (
      !tab ||
      tab.incognito ||
      !tab.url ||
      !isRoutableUrl(tab.url) ||
      tab.url !== payload.expectedUrl
    ) {
      return { status: "unavailable" };
    }
    const resolved = resolveUndoPlacement(
      payload.placement,
      input.windowId,
      input.configuration,
      input.inventory,
      associations
    );
    const actions = buildLivePlacementActions(
      tab,
      resolved,
      input.configuration
    );
    if (actions.length === 0) return { status: "unavailable" };
    return buildActionPlan("undo", actions, { requireCheckpoint: false });
  }

  return { status: "unavailable" };
}

export function undoPlanIsDegraded(
  payload: UndoPayload,
  windowId: number,
  configuration: Configuration,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[] = []
): boolean {
  if (
    payload.kind !== "restoreClosedTab" &&
    payload.kind !== "restorePlacement"
  ) {
    return false;
  }
  return resolveUndoPlacement(
    payload.placement,
    windowId,
    configuration,
    inventory,
    associations
  ).degraded;
}
