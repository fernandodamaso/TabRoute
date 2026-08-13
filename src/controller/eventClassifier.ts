import { isRoutableUrl } from "../chrome/types";
import type {
  ChromeEventHint,
  ChromeInventory,
  Configuration,
  ManualOverride,
  ManualPlacement,
  RuntimeSession,
  ChromeAssociation
} from "../domain/types";
import {
  purgeClosedTab,
  transferReplacedTab
} from "../state/runtimeSession";
import {
  settlePendingGroupRemovals,
  startPendingGroupRemoval
} from "../groups/groupLifecycle";
import { classifyGuardedEvent } from "../actions/operationGuards";

export interface EventClassification {
  guarded: boolean;
  deferred: boolean;
  manualOverride?: ManualOverride;
  requests: ReconciliationRequest[];
  session: RuntimeSession;
}

export type ReconciliationRequest =
  | { scope: { kind: "tab"; tabId: number }; reason: string }
  | { scope: { kind: "group"; chromeGroupId: number }; reason: string }
  | { scope: { kind: "all" }; reason: string };

function tabFromInventory(inventory: ChromeInventory, tabId: number) {
  return inventory.tabs.find((tab) => tab.id === tabId);
}

function tabIdFromEvent(event: ChromeEventHint): number | undefined {
  switch (event.kind) {
    case "tabCreated":
    case "tabUpdated":
    case "tabActivated":
    case "tabMoved":
    case "tabAttached":
    case "tabDetached":
    case "tabRemoved":
      return event.tabId;
    case "tabReplaced":
      return event.addedTabId;
    default:
      return undefined;
  }
}


function isIncognitoSubject(
  event: ChromeEventHint,
  inventory: ChromeInventory
): boolean {
  switch (event.kind) {
    case "tabCreated":
    case "tabUpdated":
    case "tabActivated":
    case "tabMoved":
    case "tabAttached":
    case "tabDetached":
    case "tabRemoved": {
      const tab = tabFromInventory(inventory, event.tabId);
      return !tab || tab.incognito;
    }
    case "tabReplaced": {
      const tab = tabFromInventory(inventory, event.addedTabId);
      return !tab || tab.incognito;
    }
    case "groupCreated":
    case "groupUpdated":
    case "groupMoved": {
      const group = inventory.groups.find(
        (candidate) => candidate.id === event.group.id
      );
      if (!group) return true;
      const window = inventory.windows.find(
        (candidate) => candidate.id === group.windowId
      );
      return !window || window.incognito || window.type !== "normal";
    }
    case "groupRemoved": {
      if (event.group.shared) return true;
      const window = inventory.windows.find(
        (candidate) => candidate.id === event.group.windowId
      );
      if (!window) return false;
      return window.incognito || window.type !== "normal";
    }
    case "windowFocusChanged":
      return false;
    case "windowRemoved":
      return false;
    case "alarm":
      return false;
    default:
      return false;
  }
}

function recordObservation(
  session: RuntimeSession,
  tabId: number,
  url: string | undefined,
  now: number
): RuntimeSession {
  const existing = session.tabObservations.find(
    (observation) => observation.tabId === tabId
  );
  if (existing) {
    return {
      ...session,
      tabObservations: session.tabObservations.map((observation) =>
        observation.tabId === tabId
          ? {
              ...observation,
              lastObservedUrl: url ?? observation.lastObservedUrl
            }
          : observation
      )
    };
  }
  const ordinal = session.nextObservationOrdinal;
  return {
    ...session,
    nextObservationOrdinal: ordinal + 1,
    tabObservations: [
      ...session.tabObservations,
      {
        tabId,
        firstObservedAt: now,
        firstObservedOrdinal: ordinal,
        lastObservedUrl: url ?? ""
      }
    ]
  };
}

function isSharedGroupMember(
  inventory: ChromeInventory,
  tabId: number
): boolean {
  const tab = tabFromInventory(inventory, tabId);
  if (!tab || tab.chromeGroupId < 0) return false;
  const group = inventory.groups.find(
    (candidate) => candidate.id === tab.chromeGroupId
  );
  return group?.shared === true;
}

function placementRequest(
  tabId: number,
  reason: string
): ReconciliationRequest {
  return { scope: { kind: "tab", tabId }, reason };
}

function deriveManualPlacement(
  inventory: ChromeInventory,
  tabId: number,
  associations: readonly ChromeAssociation[]
): ManualPlacement | undefined {
  const tab = tabFromInventory(inventory, tabId);
  if (!tab) return undefined;
  const group =
    tab.chromeGroupId >= 0
      ? inventory.groups.find((candidate) => candidate.id === tab.chromeGroupId)
      : undefined;
  if (group?.shared) return { kind: "leaveWherePlaced" };
  if (tab.chromeGroupId < 0) return { kind: "ungrouped" };
  const association = associations.find(
    (candidate) => candidate.chromeGroupId === tab.chromeGroupId
  );
  if (association) {
    return { kind: "managedGroup", managedGroupId: association.managedGroupId };
  }
  return { kind: "leaveWherePlaced" };
}

function writeManualOverride(
  session: RuntimeSession,
  tabId: number,
  placement: ManualPlacement,
  now: number
): RuntimeSession {
  return {
    ...session,
    manualOverrides: {
      ...session.manualOverrides,
      [String(tabId)]: { tabId, placement, createdAt: now }
    }
  };
}

function isPlacementChangeEvent(event: ChromeEventHint): boolean {
  return (
    event.kind === "tabAttached" ||
    (event.kind === "tabUpdated" && event.groupChanged)
  );
}

function isPendingGroupMoveAttach(
  session: RuntimeSession,
  tabId: number,
  inventory: ChromeInventory
): boolean {
  if (session.pendingGroupRemovals.length === 0) return false;
  const tab = tabFromInventory(inventory, tabId);
  if (!tab) return false;
  return session.pendingGroupRemovals.some((pending) => {
    if (pending.memberTabIds.includes(tabId)) return true;
    if (tab.chromeGroupId < 0) return false;
    return pending.memberTabIds.some((memberId) => {
      const member = tabFromInventory(inventory, memberId);
      return member !== undefined && member.chromeGroupId === tab.chromeGroupId;
    });
  });
}

export function classifyChromeEvent(
  event: ChromeEventHint,
  inventory: ChromeInventory,
  session: RuntimeSession,
  now: number,
  configuration?: Configuration
): EventClassification {
  if (event.kind === "tabRemoved") {
    const current = purgeClosedTab(session, event.tabId);
    return { guarded: false, deferred: false, requests: [], session: current };
  }

  if (isIncognitoSubject(event, inventory)) {
    return { guarded: false, deferred: false, requests: [], session };
  }

  let current = session;

  if (event.kind === "windowFocusChanged") {
    if (event.focus.kind === "none") {
      return { guarded: false, deferred: false, requests: [], session: current };
    }
    const focus = event.focus;
    if (focus.kind === "normal") {
      const window = inventory.windows.find(
        (candidate) =>
          candidate.id === focus.windowId && candidate.type === "normal"
      );
      if (window) {
        current = { ...current, lastFocusedNormalWindowId: window.id };
      }
    }
    return { guarded: false, deferred: false, requests: [], session: current };
  }

  if (event.kind === "tabReplaced") {
    current = transferReplacedTab(
      current,
      event.removedTabId,
      event.addedTabId
    );
    return {
      guarded: false,
      deferred: false,
      requests: [
        placementRequest(event.addedTabId, "tab-replaced")
      ],
      session: current
    };
  }

  const guardDecision = classifyGuardedEvent(event, inventory, current, now);
  current = guardDecision.session;
  if (guardDecision.kind === "defer") {
    return { guarded: true, deferred: true, requests: [], session: current };
  }
  if (guardDecision.kind === "echo") {
    return { guarded: true, deferred: false, requests: [], session: current };
  }
  if (guardDecision.kind === "manual") {
    current = guardDecision.session;
    const tabId = tabIdFromEvent(event);
    if (tabId !== undefined) {
      const placement = deriveManualPlacement(
        inventory,
        tabId,
        current.associations
      );
      if (placement) {
        current = writeManualOverride(current, tabId, placement, now);
        return {
          guarded: false,
          deferred: false,
          manualOverride: current.manualOverrides[String(tabId)],
          requests: [],
          session: current
        };
      }
    }
  }

  if (isPlacementChangeEvent(event)) {
    const tabId = tabIdFromEvent(event);
    if (tabId !== undefined) {
      if (isPendingGroupMoveAttach(current, tabId, inventory)) {
        return { guarded: false, deferred: false, requests: [], session: current };
      }
      if (isSharedGroupMember(inventory, tabId)) {
        current = writeManualOverride(
          current,
          tabId,
          { kind: "leaveWherePlaced" },
          now
        );
        return {
          guarded: false,
          deferred: false,
          manualOverride: current.manualOverrides[String(tabId)],
          requests: [],
          session: current
        };
      }
      const placement = deriveManualPlacement(
        inventory,
        tabId,
        current.associations
      );
      if (placement) {
        current = writeManualOverride(current, tabId, placement, now);
        return {
          guarded: false,
          deferred: false,
          manualOverride: current.manualOverrides[String(tabId)],
          requests: [],
          session: current
        };
      }
    }
  }

  switch (event.kind) {
    case "tabCreated":
    case "tabUpdated": {
      const tab = tabFromInventory(inventory, event.tabId);
      if (!tab) {
        return { guarded: false, deferred: false, requests: [], session: current };
      }
      current = recordObservation(current, tab.id, tab.url, now);
      if (!isRoutableUrl(tab.url)) {
        return { guarded: false, deferred: false, requests: [], session: current };
      }
      if (
        event.kind === "tabUpdated" &&
        !event.urlChanged &&
        !event.groupChanged &&
        !event.pinnedChanged
      ) {
        return { guarded: false, deferred: false, requests: [], session: current };
      }
      if (isSharedGroupMember(inventory, tab.id)) {
        return { guarded: false, deferred: false, requests: [], session: current };
      }
      return {
        guarded: false,
        deferred: false,
        requests: [placementRequest(tab.id, "routable")],
        session: current
      };
    }
    case "tabActivated": {
      const tab = tabFromInventory(inventory, event.tabId);
      if (tab) {
        current = recordObservation(current, tab.id, tab.url, now);
      }
      return { guarded: false, deferred: false, requests: [], session: current };
    }
    case "tabMoved":
    case "tabAttached":
    case "tabDetached": {
      const tab = tabFromInventory(inventory, event.tabId);
      if (!tab || !isRoutableUrl(tab.url)) {
        return { guarded: false, deferred: false, requests: [], session: current };
      }
      if (isSharedGroupMember(inventory, tab.id)) {
        return { guarded: false, deferred: false, requests: [], session: current };
      }
      return {
        guarded: false,
        deferred: false,
        requests: [placementRequest(tab.id, "placement-changed")],
        session: current
      };
    }
    case "groupCreated":
    case "groupUpdated":
    case "groupMoved": {
      if (configuration) {
        current = settlePendingGroupRemovals({
          session: current,
          inventory,
          configuration,
          now
        });
      }
      return {
        guarded: false,
        deferred: false,
        requests: [
          {
            scope: { kind: "group", chromeGroupId: event.group.id },
            reason: event.kind
          }
        ],
        session: current
      };
    }
    case "groupRemoved": {
      current = startPendingGroupRemoval({
        session: current,
        inventoryBeforeRemoval: inventory,
        removed: event.group,
        now
      });
      if (configuration) {
        current = settlePendingGroupRemovals({
          session: current,
          inventory,
          configuration,
          now
        });
      }
      return {
        guarded: false,
        deferred: false,
        requests: [
          {
            scope: { kind: "group", chromeGroupId: event.group.id },
            reason: event.kind
          }
        ],
        session: current
      };
    }
    case "windowRemoved":
      return {
        guarded: false,
        deferred: false,
        requests: [{ scope: { kind: "all" }, reason: "window-removed" }],
        session: current
      };
    case "alarm":
      if (configuration) {
        current = settlePendingGroupRemovals({
          session: current,
          inventory,
          configuration,
          now
        });
      }
      return {
        guarded: false,
        deferred: false,
        requests: [{ scope: { kind: "all" }, reason: "alarm" }],
        session: current
      };
    default:
      return { guarded: false, deferred: false, requests: [], session: current };
  }
}
