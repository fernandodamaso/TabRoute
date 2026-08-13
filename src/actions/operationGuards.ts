import { findTab } from "../chrome/types";
import type {
  ChromeEventHint,
  ChromeInventory,
  GuardEventKind,
  GuardPostcondition,
  OperationGuard,
  RuntimeSession
} from "../domain/types";
import type { ActionPlan } from "./types";

export const GUARD_QUIET_MS = 750;
export const GUARD_HARD_MS = 5000;

export function buildExpectedFootprint(
  plan: ActionPlan
): Pick<
  OperationGuard,
  "operation" | "expectedEventKinds" | "postcondition" | "tabIds" | "chromeGroupIds"
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
      ...(chromeGroupId !== undefined ? { chromeGroupId } : {})
    }
  };
}

export type GuardEventDecision =
  | { kind: "unmatched"; session: RuntimeSession }
  | { kind: "defer"; guard: OperationGuard; session: RuntimeSession }
  | { kind: "echo"; guard: OperationGuard; session: RuntimeSession }
  | { kind: "manual"; retiredGuard: OperationGuard; session: RuntimeSession };

export function postconditionHolds(
  postcondition: GuardPostcondition,
  inventory: ChromeInventory
): boolean {
  if (postcondition.kind === "managedGroupState") {
    const group = inventory.groups.find(
      (candidate) =>
        !candidate.shared &&
        (postcondition.windowId === undefined ||
          candidate.windowId === postcondition.windowId) &&
        (postcondition.title === undefined ||
          candidate.title === postcondition.title)
    );
    if (!group) return false;
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
  for (const tabId of postcondition.tabIds) {
    const tab = findTab(inventory, tabId);
    if (!tab) return false;
    if (
      postcondition.windowId !== undefined &&
      tab.windowId !== postcondition.windowId
    )
      return false;
    if (postcondition.ungrouped) {
      if (tab.chromeGroupId >= 0) return false;
      continue;
    }
    if (postcondition.chromeGroupId !== undefined) {
      if (tab.chromeGroupId !== postcondition.chromeGroupId) return false;
    } else if (tab.chromeGroupId < 0) {
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

function removeGuardAt(
  session: RuntimeSession,
  index: number
): RuntimeSession {
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
    if (guard.postcondition && postconditionHolds(guard.postcondition, inventory)) {
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

  const guardIndex = current.operationGuards.findIndex(
    (candidate) =>
      candidate.browserSessionId === session.browserSessionId &&
      eventMatchesGuard(event, candidate)
  );

  if (guardIndex === -1) {
    if (
      expired.manualGuard &&
      eventMatchesGuard(event, expired.manualGuard)
    ) {
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

  if (matched.postcondition && postconditionHolds(matched.postcondition, inventory)) {
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
