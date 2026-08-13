import type {
  BrowserSessionId,
  ChromeAssociation,
  ChromeInventory,
  GuardPostcondition,
  ManualOverride,
  OperationGuard,
  PendingGroupRemoval,
  RuntimeSession,
  TabObservation,
  UUID
} from "../domain/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createEmptyRuntimeSession(input: {
  browserSessionId: BrowserSessionId;
}): RuntimeSession {
  return {
    schemaVersion: 1,
    browserSessionId: input.browserSessionId,
    nextObservationOrdinal: 0,
    tabObservations: [],
    manualOverrides: {},
    intentionallyClosedGroupIds: [],
    operationGuards: [],
    pendingGroupRemovals: [],
    associations: []
  };
}

export function parseRuntimeSession(
  value: unknown,
  fallbackBrowserSessionId: BrowserSessionId
): RuntimeSession {
  if (!isRecord(value)) {
    return createEmptyRuntimeSession({
      browserSessionId: fallbackBrowserSessionId
    });
  }
  const browserSessionId =
    typeof value.browserSessionId === "string" &&
    value.browserSessionId.length > 0
      ? (value.browserSessionId as BrowserSessionId)
      : fallbackBrowserSessionId;
  return {
    schemaVersion: 1,
    browserSessionId,
    nextObservationOrdinal:
      typeof value.nextObservationOrdinal === "number"
        ? value.nextObservationOrdinal
        : 0,
    tabObservations: Array.isArray(value.tabObservations)
      ? (value.tabObservations as TabObservation[])
      : [],
    manualOverrides: isRecord(value.manualOverrides)
      ? (value.manualOverrides as Record<string, ManualOverride>)
      : {},
    intentionallyClosedGroupIds: Array.isArray(
      value.intentionallyClosedGroupIds
    )
      ? (value.intentionallyClosedGroupIds as UUID[])
      : [],
    operationGuards: Array.isArray(value.operationGuards)
      ? (value.operationGuards as OperationGuard[])
      : [],
    pendingGroupRemovals: Array.isArray(value.pendingGroupRemovals)
      ? (value.pendingGroupRemovals as PendingGroupRemoval[])
      : [],
    associations: Array.isArray(value.associations)
      ? value.associations.map(parseAssociation)
      : [],
    ...(typeof value.lastFocusedNormalWindowId === "number"
      ? { lastFocusedNormalWindowId: value.lastFocusedNormalWindowId }
      : {})
  };
}

export function transferReplacedTab(
  session: RuntimeSession,
  removedTabId: number,
  addedTabId: number
): RuntimeSession {
  const removedKey = String(removedTabId);
  const addedKey = String(addedTabId);
  const manualOverrides = { ...session.manualOverrides };
  const transferred = manualOverrides[removedKey];
  delete manualOverrides[removedKey];
  if (transferred) {
    manualOverrides[addedKey] = { ...transferred, tabId: addedTabId };
  }
  return {
    ...session,
    tabObservations: session.tabObservations.map((observation) =>
      observation.tabId === removedTabId
        ? { ...observation, tabId: addedTabId }
        : observation
    ),
    manualOverrides,
    operationGuards: session.operationGuards.map((guard) => ({
      ...guard,
      tabIds: remapTabIds(guard.tabIds, removedTabId, addedTabId),
      postcondition: remapPostconditionTabIds(
        guard.postcondition,
        removedTabId,
        addedTabId
      )
    })),
    pendingGroupRemovals: session.pendingGroupRemovals.map((pending) => ({
      ...pending,
      memberTabIds: remapTabIds(pending.memberTabIds, removedTabId, addedTabId)
    }))
  };
}

export function purgeClosedTab(
  session: RuntimeSession,
  tabId: number
): RuntimeSession {
  const stillNeeded =
    session.operationGuards.some((guard) => guard.tabIds.includes(tabId)) ||
    session.pendingGroupRemovals.some((pending) =>
      pending.memberTabIds.includes(tabId)
    );
  if (stillNeeded) return session;
  const manualOverrides = { ...session.manualOverrides };
  delete manualOverrides[String(tabId)];
  return {
    ...session,
    tabObservations: session.tabObservations.filter(
      (observation) => observation.tabId !== tabId
    ),
    manualOverrides
  };
}

export function scrubRuntimeState(
  session: RuntimeSession,
  inventory: ChromeInventory
): RuntimeSession {
  const tabIds = new Set(inventory.tabs.map((tab) => tab.id));
  const groupIds = new Set(inventory.groups.map((group) => group.id));
  const windowIds = new Set(inventory.windows.map((window) => window.id));
  return {
    ...session,
    lastFocusedNormalWindowId:
      session.lastFocusedNormalWindowId !== undefined &&
      windowIds.has(session.lastFocusedNormalWindowId)
        ? session.lastFocusedNormalWindowId
        : undefined,
    operationGuards: session.operationGuards.map((guard) => ({
      ...guard,
      tabIds: guard.tabIds.filter((tabId) => tabIds.has(tabId)),
      chromeGroupIds: guard.chromeGroupIds.filter((chromeGroupId) =>
        groupIds.has(chromeGroupId)
      ),
      postcondition: scrubPostcondition(
        guard.postcondition,
        tabIds,
        groupIds,
        windowIds
      )
    })),
    associations: session.associations.filter(
      (association) =>
        groupIds.has(association.chromeGroupId) &&
        windowIds.has(association.chromeWindowId)
    )
  };
}

function remapTabIds(
  tabIds: number[],
  removedTabId: number,
  addedTabId: number
) {
  return tabIds.map((tabId) => (tabId === removedTabId ? addedTabId : tabId));
}

function remapPostconditionTabIds(
  postcondition: GuardPostcondition | undefined,
  removedTabId: number,
  addedTabId: number
): GuardPostcondition | undefined {
  if (postcondition?.kind !== "tabPlacement") {
    return postcondition;
  }
  return {
    ...postcondition,
    tabIds: remapTabIds(postcondition.tabIds, removedTabId, addedTabId)
  };
}

function scrubPostcondition(
  postcondition: GuardPostcondition | undefined,
  tabIds: Set<number>,
  groupIds: Set<number>,
  windowIds: Set<number>
): GuardPostcondition | undefined {
  if (!postcondition) {
    return undefined;
  }
  if (postcondition.kind === "tabPlacement") {
    const { chromeGroupId, windowId, ...rest } = postcondition;
    return {
      ...rest,
      tabIds: postcondition.tabIds.filter((tabId) => tabIds.has(tabId)),
      ...(windowId !== undefined && windowIds.has(windowId)
        ? { windowId }
        : {}),
      ...(chromeGroupId !== undefined && groupIds.has(chromeGroupId)
        ? { chromeGroupId }
        : {})
    };
  }
  const { windowId, ...rest } = postcondition;
  return {
    ...rest,
    ...(windowId !== undefined && windowIds.has(windowId) ? { windowId } : {})
  };
}

function parseAssociation(value: unknown): ChromeAssociation {
  const record = isRecord(value) ? value : {};
  return {
    managedGroupId: record.managedGroupId as UUID,
    chromeGroupId:
      typeof record.chromeGroupId === "number" ? record.chromeGroupId : 0,
    chromeWindowId:
      typeof record.chromeWindowId === "number" ? record.chromeWindowId : 0,
    observedTitle:
      typeof record.observedTitle === "string" ? record.observedTitle : "",
    observedMemberUrls: Array.isArray(record.observedMemberUrls)
      ? record.observedMemberUrls.filter(
          (item): item is string => typeof item === "string"
        )
      : [],
    observedAt: typeof record.observedAt === "number" ? record.observedAt : 0
  };
}
