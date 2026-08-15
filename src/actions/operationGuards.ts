import { findTab } from "../chrome/types";
import type {
  ChromeAssociation,
  ChromeEventHint,
  ChromeInventory,
  GuardEventKind,
  GuardPostcondition,
  OperationGuard,
  RuntimeSession
} from "../domain/types";
import type { PlannedAction, RoutePlan } from "./types";

export const GUARD_QUIET_MS = 750;
export const GUARD_HARD_MS = 5000;

type OrderedTabPlacementPostcondition = Extract<
  GuardPostcondition,
  { kind: "tabPlacement" }
> & { startIndex?: number };

export function buildExpectedFootprint(
  plan: RoutePlan
): Pick<
  OperationGuard,
  | "operation"
  | "expectedEventKinds"
  | "postcondition"
  | "tabIds"
  | "chromeGroupIds"
> {
  if (plan.kind === "ungroup") {
    return {
      operation: "ungroupTabs",
      tabIds: [plan.tab.id],
      chromeGroupIds:
        plan.tab.chromeGroupId >= 0 ? [plan.tab.chromeGroupId] : [],
      expectedEventKinds: [
        "tabUpdated",
        "tabMoved",
        "tabAttached",
        "groupRemoved"
      ],
      postcondition: {
        kind: "tabPlacement",
        tabIds: [plan.tab.id],
        windowId: plan.tab.windowId,
        ungrouped: true
      }
    };
  }
  const creating = plan.groupInput.kind === "create";
  const chromeGroupId =
    plan.groupInput.kind === "existing"
      ? plan.groupInput.chromeGroupId
      : undefined;
  const expectedEventKinds: GuardEventKind[] = creating
    ? ["tabUpdated", "groupCreated", "tabMoved", "tabAttached", "tabReplaced"]
    : ["tabUpdated", "groupUpdated", "tabMoved", "tabAttached", "tabReplaced"];
  return {
    operation: "assignTabsToManagedGroup",
    tabIds: [plan.tab.id],
    chromeGroupIds: chromeGroupId !== undefined ? [chromeGroupId] : [],
    expectedEventKinds,
    postcondition: {
      kind: "tabPlacement",
      tabIds: [plan.tab.id],
      windowId: plan.tab.windowId,
      ...(chromeGroupId !== undefined ? { chromeGroupId } : { grouped: true })
    }
  };
}
export interface ActionFootprint {
  operation: OperationGuard["operation"];
  expectedEventKinds: GuardEventKind[];
  postcondition?: GuardPostcondition;
  tabIds: number[];
  chromeGroupIds: number[];
  pendingTab?: { url: string; windowId?: number };
}

export function buildExpectedActionFootprint(input: {
  action: PlannedAction;
  tabIds: readonly number[];
  chromeGroupIds?: readonly number[];
  outputChromeGroupId?: number;
  absentTabIds?: readonly number[];
  associations?: readonly ChromeAssociation[];
}): ActionFootprint {
  const tabIds = [...input.tabIds];
  const chromeGroupIds = [
    ...(input.chromeGroupIds ?? []),
    ...(input.outputChromeGroupId === undefined
      ? []
      : [input.outputChromeGroupId])
  ];
  const action = input.action;
  switch (action.kind) {
    case "createTab":
      return {
        operation: "createTab",
        expectedEventKinds: ["tabCreated", "tabUpdated", "tabAttached"],
        postcondition: { kind: "tabsPresent", tabIds },
        tabIds,
        chromeGroupIds,
        pendingTab: action.input.url
          ? { url: action.input.url, windowId: action.input.windowId }
          : undefined
      };
    case "restoreClosedTab":
      return {
        operation: "restoreClosedTab",
        expectedEventKinds: ["tabCreated", "tabUpdated", "tabAttached"],
        postcondition: { kind: "tabsPresent", tabIds },
        tabIds,
        chromeGroupIds,
        pendingTab: action.expectedUrl
          ? { url: action.expectedUrl, windowId: action.windowId }
          : undefined
      };
    case "moveTabs":
      return {
        operation: "moveTabs",
        expectedEventKinds: ["tabMoved", "tabAttached", "tabUpdated"],
        postcondition: {
          kind: "tabPlacement",
          tabIds,
          windowId: action.windowId
        },
        tabIds,
        chromeGroupIds
      };
    case "assignTabsToManagedGroup":
      return {
        operation: "assignTabsToManagedGroup",
        expectedEventKinds: [
          "tabUpdated",
          "groupCreated",
          "groupUpdated",
          "tabMoved",
          "tabAttached",
          "tabReplaced"
        ],
        postcondition: {
          kind: "tabPlacement",
          tabIds,
          windowId: action.windowId,
          ...(input.outputChromeGroupId === undefined
            ? { grouped: true }
            : { chromeGroupId: input.outputChromeGroupId })
        },
        tabIds,
        chromeGroupIds
      };
    case "assignTabsToUnmanagedGroup":
      return {
        operation: "assignTabsToUnmanagedGroup",
        expectedEventKinds: ["tabUpdated", "tabMoved", "tabAttached"],
        postcondition: {
          kind: "tabPlacement",
          tabIds,
          windowId: action.windowId,
          chromeGroupId: action.chromeGroupId
        },
        tabIds,
        chromeGroupIds: [...chromeGroupIds, action.chromeGroupId]
      };
    case "ungroupTabs":
      return {
        operation: "ungroupTabs",
        expectedEventKinds: [
          "tabUpdated",
          "tabMoved",
          "tabAttached",
          "groupRemoved"
        ],
        postcondition: { kind: "tabPlacement", tabIds, ungrouped: true },
        tabIds,
        chromeGroupIds
      };
    case "updateManagedGroup": {
      const resolvedGroupId =
        input.outputChromeGroupId ??
        input.associations?.find(
          (assoc) =>
            assoc.managedGroupId === action.managedGroupId &&
            (action.windowId === undefined ||
              assoc.chromeWindowId === action.windowId)
        )?.chromeGroupId;
      return {
        operation: "updateManagedGroup",
        expectedEventKinds: ["groupUpdated"],
        postcondition:
          resolvedGroupId === undefined
            ? undefined
            : {
                kind: "managedGroupState",
                managedGroupId: action.managedGroupId,
                chromeGroupId: resolvedGroupId,
                ...(action.windowId === undefined
                  ? {}
                  : { windowId: action.windowId }),
                ...(action.patch.title === undefined
                  ? {}
                  : { title: action.patch.title }),
                ...(action.patch.color === undefined
                  ? {}
                  : { color: action.patch.color }),
                ...(action.patch.collapsed === undefined
                  ? {}
                  : { collapsed: action.patch.collapsed })
              },
        tabIds,
        chromeGroupIds:
          resolvedGroupId === undefined
            ? chromeGroupIds
            : [...chromeGroupIds, resolvedGroupId]
      };
    }
    case "moveManagedGroup": {
      const resolvedGroupId =
        input.outputChromeGroupId ??
        input.associations?.find(
          (assoc) =>
            assoc.managedGroupId === action.managedGroupId &&
            assoc.chromeWindowId === action.windowId
        )?.chromeGroupId;
      return {
        operation: "moveManagedGroup",
        expectedEventKinds: ["groupMoved", "groupUpdated"],
        postcondition:
          resolvedGroupId === undefined
            ? undefined
            : {
                kind: "managedGroupState",
                managedGroupId: action.managedGroupId,
                chromeGroupId: resolvedGroupId,
                windowId: action.windowId
              },
        tabIds,
        chromeGroupIds:
          resolvedGroupId === undefined
            ? chromeGroupIds
            : [...chromeGroupIds, resolvedGroupId]
      };
    }
    case "reorderTabs":
      return {
        operation: "reorderTabs",
        expectedEventKinds: ["tabMoved", "tabAttached", "tabUpdated"],
        postcondition: {
          kind: "tabPlacement",
          tabIds,
          windowId: action.windowId,
          startIndex: action.index
        } as OrderedTabPlacementPostcondition,
        tabIds,
        chromeGroupIds
      };
    case "focusTab":
      return {
        operation: "focusTab",
        expectedEventKinds: ["tabActivated"],
        postcondition: {
          kind: "tabPlacement",
          tabIds,
          windowId: action.windowId
        },
        tabIds,
        chromeGroupIds
      };
    case "closeDuplicate":
      return {
        operation: "closeDuplicate",
        expectedEventKinds: ["tabRemoved"],
        postcondition: {
          kind: "tabsAbsent",
          tabIds: [...(input.absentTabIds ?? tabIds)]
        },
        tabIds,
        chromeGroupIds
      };
  }
}

export type GuardEventDecision =
  | { kind: "unmatched"; session: RuntimeSession }
  | { kind: "defer"; guard: OperationGuard; session: RuntimeSession }
  | { kind: "echo"; guard: OperationGuard; session: RuntimeSession }
  | { kind: "manual"; retiredGuard: OperationGuard; session: RuntimeSession };

export function postconditionHolds(
  postcondition: GuardPostcondition | undefined,
  inventory: ChromeInventory
): boolean {
  if (!postcondition) return false;
  if (postcondition.kind === "managedGroupState") {
    if (postcondition.chromeGroupId === undefined) return false;
    const group = inventory.groups.find(
      (candidate) => candidate.id === postcondition.chromeGroupId
    );
    if (!group || group.shared) return false;
    if (
      postcondition.windowId !== undefined &&
      group.windowId !== postcondition.windowId
    )
      return false;
    if (
      postcondition.title !== undefined &&
      group.title !== postcondition.title
    )
      return false;
    if (
      postcondition.color !== undefined &&
      group.color !== postcondition.color
    )
      return false;
    if (
      postcondition.collapsed !== undefined &&
      group.collapsed !== postcondition.collapsed
    )
      return false;
    return true;
  }
  if (postcondition.kind === "tabsPresent")
    return postcondition.tabIds.every((tabId) => !!findTab(inventory, tabId));
  if (postcondition.kind === "tabsAbsent")
    return postcondition.tabIds.every((tabId) => !findTab(inventory, tabId));

  const ordered = postcondition as OrderedTabPlacementPostcondition;
  for (let offset = 0; offset < postcondition.tabIds.length; offset += 1) {
    const tabId = postcondition.tabIds[offset]!;
    const tab = findTab(inventory, tabId);
    if (!tab) return false;
    if (
      postcondition.windowId !== undefined &&
      tab.windowId !== postcondition.windowId
    )
      return false;
    if (
      ordered.startIndex !== undefined &&
      tab.index !== ordered.startIndex + offset
    )
      return false;
    if (postcondition.ungrouped) {
      if (tab.chromeGroupId >= 0) return false;
      continue;
    }
    if (postcondition.chromeGroupId !== undefined) {
      if (tab.chromeGroupId !== postcondition.chromeGroupId) return false;
    } else if (postcondition.grouped && tab.chromeGroupId < 0) {
      return false;
    }
  }
  return true;
}
function eventMatchesGuard(
  event: ChromeEventHint,
  guard: OperationGuard
): boolean {
  if (!guard.expectedEventKinds.includes(event.kind as GuardEventKind))
    return false;
  switch (event.kind) {
    case "tabCreated":
    case "tabUpdated":
    case "tabActivated":
    case "tabMoved":
    case "tabAttached":
    case "tabDetached":
    case "tabRemoved":
      return guard.tabIds.includes(event.tabId);
    case "tabReplaced":
      return (
        guard.tabIds.includes(event.addedTabId) ||
        guard.tabIds.includes(event.removedTabId)
      );
    case "groupCreated":
    case "groupUpdated":
    case "groupMoved":
    case "groupRemoved":
      return guard.chromeGroupIds.includes(event.group.id);
    default:
      return false;
  }
}

function replaceGuard(
  session: RuntimeSession,
  index: number,
  guard: OperationGuard
): RuntimeSession {
  const operationGuards = [...session.operationGuards];
  operationGuards[index] = guard;
  return { ...session, operationGuards };
}

function removeGuardAt(session: RuntimeSession, index: number): RuntimeSession {
  return {
    ...session,
    operationGuards: session.operationGuards.filter((_, i) => i !== index)
  };
}

function processExpiredGuards(
  inventory: ChromeInventory,
  session: RuntimeSession,
  now: number
): {
  session: RuntimeSession;
  manualGuard?: OperationGuard;
} {
  let manualGuard: OperationGuard | undefined;
  const remaining: OperationGuard[] = [];
  for (const guard of session.operationGuards) {
    if (now < guard.expiresAt) {
      remaining.push(guard);
      continue;
    }
    if (
      guard.postcondition &&
      postconditionHolds(guard.postcondition, inventory)
    ) {
      continue;
    }
    manualGuard = guard;
  }
  return { session: { ...session, operationGuards: remaining }, manualGuard };
}

export function settleOperationGuards(
  inventory: ChromeInventory,
  session: RuntimeSession,
  now: number
): RuntimeSession {
  const operationGuards = session.operationGuards.filter((guard) => {
    if (guard.phase === "executing") {
      if (now < guard.expiresAt) return true;
      return false;
    }
    const quiet = guard.settleAfter !== undefined && now >= guard.settleAfter;
    const hard = now >= guard.expiresAt;
    if (!quiet && !hard) return true;
    if (!guard.postcondition) return false;
    if (postconditionHolds(guard.postcondition, inventory)) return false;
    return true;
  });
  return { ...session, operationGuards };
}

export function classifyGuardedEvent(
  event: ChromeEventHint,
  inventory: ChromeInventory,
  session: RuntimeSession,
  now: number
): GuardEventDecision {
  let current = settleOperationGuards(inventory, session, now);
  const expired = processExpiredGuards(inventory, current, now);
  current = expired.session;

  let guardIndex = current.operationGuards.findIndex(
    (candidate) =>
      candidate.browserSessionId === session.browserSessionId &&
      eventMatchesGuard(event, candidate)
  );

  if (guardIndex === -1 && event.kind === "tabCreated") {
    const createdTab = findTab(inventory, event.tabId);
    const tabUrl = createdTab?.url ?? createdTab?.pendingUrl;
    const tabWindowId = createdTab?.windowId;

    guardIndex = current.operationGuards.findIndex((candidate) => {
      if (
        candidate.browserSessionId !== session.browserSessionId ||
        candidate.phase !== "executing" ||
        !candidate.pendingTab ||
        !candidate.expectedEventKinds.includes("tabCreated") ||
        tabUrl === undefined
      ) {
        return false;
      }
      if (
        candidate.pendingTab.windowId !== undefined &&
        tabWindowId !== undefined &&
        candidate.pendingTab.windowId !== tabWindowId
      ) {
        return false;
      }
      return tabUrl === candidate.pendingTab.url;
    });

    if (guardIndex !== -1) {
      const targetGuard = current.operationGuards[guardIndex]!;
      const newTabIds = targetGuard.tabIds.includes(event.tabId)
        ? targetGuard.tabIds
        : [...targetGuard.tabIds, event.tabId];
      const newPostcondition: GuardPostcondition | undefined =
        targetGuard.postcondition?.kind === "tabsPresent"
          ? {
              ...targetGuard.postcondition,
              tabIds: targetGuard.postcondition.tabIds.includes(event.tabId)
                ? targetGuard.postcondition.tabIds
                : [...targetGuard.postcondition.tabIds, event.tabId]
            }
          : targetGuard.postcondition;
      const seenEventKinds: GuardEventKind[] =
        targetGuard.seenEventKinds.includes("tabCreated")
          ? targetGuard.seenEventKinds
          : [...targetGuard.seenEventKinds, "tabCreated"];

      const boundGuard: OperationGuard = {
        ...targetGuard,
        tabIds: newTabIds,
        postcondition: newPostcondition,
        seenEventKinds,
        pendingTab: undefined
      };

      return {
        kind: "defer",
        guard: boundGuard,
        session: replaceGuard(current, guardIndex, boundGuard)
      };
    }
  }

  if (guardIndex === -1) {
    if (expired.manualGuard && eventMatchesGuard(event, expired.manualGuard)) {
      return {
        kind: "manual",
        retiredGuard: expired.manualGuard,
        session: current
      };
    }
    return { kind: "unmatched", session: current };
  }

  const matched = current.operationGuards[guardIndex]!;
  const seenEventKinds = matched.seenEventKinds.includes(
    event.kind as GuardEventKind
  )
    ? matched.seenEventKinds
    : [...matched.seenEventKinds, event.kind as GuardEventKind];
  const updated = { ...matched, seenEventKinds };

  if (matched.phase === "executing") {
    return {
      kind: "defer",
      guard: updated,
      session: replaceGuard(current, guardIndex, updated)
    };
  }

  if (
    matched.postcondition &&
    postconditionHolds(matched.postcondition, inventory)
  ) {
    const settleAfter = Math.min(now + GUARD_QUIET_MS, matched.expiresAt);
    const echoing = { ...updated, settleAfter };
    return {
      kind: "echo",
      guard: echoing,
      session: replaceGuard(current, guardIndex, echoing)
    };
  }

  return {
    kind: "manual",
    retiredGuard: matched,
    session: removeGuardAt(current, guardIndex)
  };
}
