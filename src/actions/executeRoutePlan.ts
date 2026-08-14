import type { ChromeMutationPort, ChromeReadPort } from "../chrome/types";
import { findTab, isRoutableUrl } from "../chrome/types";
import { createUuid } from "../domain/ids";
import type {
  ActionId,
  BrowserSessionId,
  ChromeInventory,
  OperationGuard,
  UUID
} from "../domain/types";
import { appendActivityEntry } from "../activity/activityRepository";
import { createActivityEntry, type LocalRepository } from "../state/localRepository";
import type { Configuration } from "../domain/types";
import type { SessionRepository } from "../state/sessionRepository";
import {
  GUARD_HARD_MS,
  GUARD_QUIET_MS,
  buildExpectedFootprint,
  settleOperationGuards
} from "./operationGuards";
import { executeWithRetry } from "./retryPolicy";
import type { RoutePlan, RouteResult } from "./types";
export interface RouteEngineDeps {
  chrome: ChromeReadPort & ChromeMutationPort;
  session: SessionRepository;
  local?: LocalRepository;
  configuration?: Configuration;
  now?: () => number;
  createId?: () => UUID;
  delay?: (ms: number) => Promise<void>;
}

function createGuard(input: {
  plan: RoutePlan;
  browserSessionId: BrowserSessionId;
  actionId: ActionId;
  startedAt: number;
  createId: () => UUID;
  phase: OperationGuard["phase"];
  verifiedAt?: number;
  settleAfter?: number;
}): OperationGuard {
  const footprint = buildExpectedFootprint(input.plan);
  return {
    id: input.createId(),
    browserSessionId: input.browserSessionId,
    actionId: input.actionId,
    operation: footprint.operation,
    phase: input.phase,
    tabIds: footprint.tabIds,
    chromeGroupIds: footprint.chromeGroupIds,
    expectedEventKinds: footprint.expectedEventKinds,
    seenEventKinds: [],
    postcondition: footprint.postcondition,
    startedAt: input.startedAt,
    verifiedAt: input.verifiedAt,
    settleAfter: input.settleAfter,
    expiresAt: input.startedAt + GUARD_HARD_MS
  };
}
async function recordRouteActivity(
  deps: RouteEngineDeps,
  plan: RoutePlan,
  result: "success" | "failure" | "degraded" | "retry",
  errorCode?: string
): Promise<void> {
  if (!deps.local) return;
  await appendActivityEntry(
    deps.local,
    createActivityEntry({
      action: `Automatic ${plan.kind} route`,
      result,
      affectedManagedGroupIds:
        plan.kind === "ungroup" ? [] : [plan.managedGroupId],
      affectedUrls: plan.tab.url ? [plan.tab.url] : [],
      source: "reconcile",
      ...(errorCode ? { errorCode } : {}),
      createdAt: deps.now?.() ?? Date.now()
    })
  );
}

async function saveExecutingGuard(
  deps: RouteEngineDeps,
  plan: RoutePlan,
  actionId: ActionId,
  startedAt: number,
  createId: () => UUID
) {
  const session = await deps.session.loadSession();
  const guard = createGuard({
    plan,
    browserSessionId: session.browserSessionId,
    actionId,
    startedAt,
    createId,
    phase: "executing"
  });
  await deps.session.saveSession({
    ...session,
    operationGuards: [...session.operationGuards, guard]
  });
  return guard;
}

async function moveGuardToSettling(
  deps: RouteEngineDeps,
  guardId: UUID,
  verifiedAt: number,
  chromeGroupIds: number[]
) {
  const session = await deps.session.loadSession();
  await deps.session.saveSession({
    ...session,
    operationGuards: session.operationGuards.map((guard) =>
      guard.id === guardId
        ? {
            ...guard,
            phase: "settling" as const,
            verifiedAt,
            settleAfter: verifiedAt + GUARD_QUIET_MS,
            chromeGroupIds:
              chromeGroupIds.length > 0 ? chromeGroupIds : guard.chromeGroupIds,
            postcondition:
              guard.postcondition?.kind === "tabPlacement" &&
              chromeGroupIds[0] !== undefined
                ? {
                    ...guard.postcondition,
                    chromeGroupId: chromeGroupIds[0]
                  }
                : guard.postcondition
          }
        : guard
    )
  });
}

async function removeGuard(deps: RouteEngineDeps, guardId: UUID) {
  const session = await deps.session.loadSession();
  await deps.session.saveSession({
    ...session,
    operationGuards: session.operationGuards.filter(
      (guard) => guard.id !== guardId
    )
  });
}

export async function executeRoutePlan(
  plan: RoutePlan,
  deps: RouteEngineDeps
): Promise<RouteResult> {
  const now = deps.now?.() ?? Date.now();
  const createId = deps.createId ?? createUuid;
  const delay = deps.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const actionId = createId() as unknown as ActionId;
  const chrome = deps.chrome;

  const fresh = await chrome.readInventory();
  const tab = findTab(fresh, plan.tab.id);
  if (!tab || tab.incognito) return { kind: "held", reason: "incognito" };
  if (!isRoutableUrl(tab.url)) return { kind: "held", reason: "not-routable" };
  const retryEntries: Promise<void>[] = [];
  const onRetry = () => {
    retryEntries.push(recordRouteActivity(deps, plan, "retry"));
  };
  const executingGuard = await saveExecutingGuard(deps, plan, actionId, now, createId);
  let expectedChromeGroupId =
    plan.kind === "routeToGroup" && plan.groupInput.kind === "existing"
      ? plan.groupInput.chromeGroupId
      : undefined;

  let verifyTabId = plan.tab.id;

  async function refreshInventory() {
    const inventory = await chrome.readInventory();
    const session = await deps.session.loadSession();
    const currentGuard = session.operationGuards.find(
      (guard) => guard.id === executingGuard.id
    );
    verifyTabId = currentGuard?.tabIds[0] ?? plan.tab.id;
    return inventory;
  }

  function shouldAbortRetry(refreshed: unknown): "gone" | "contradiction" | undefined {
    const inventory = refreshed as ChromeInventory;
    const subject = findTab(inventory, verifyTabId);
    if (!subject) return "gone";
    if (plan.kind === "ungroup") {
      if (subject.chromeGroupId < 0) return "contradiction";
      return undefined;
    }
    const footprint = buildExpectedFootprint(plan);
    if (footprint.postcondition?.kind === "tabPlacement") {
      const postcondition = footprint.postcondition;
      const expectedGroupId =
        expectedChromeGroupId ?? postcondition.chromeGroupId;
      if (expectedGroupId !== undefined)
        return subject.chromeGroupId === expectedGroupId
          ? undefined
          : "contradiction";
      if (plan.groupInput.kind === "create" && subject.chromeGroupId < 0)
        return "contradiction";
    }
    return undefined;
  }

  try {
    if (plan.kind === "ungroup") {
      if (tab.chromeGroupId < 0) {
        await removeGuard(deps, executingGuard.id);
        return { kind: "noop", reason: "already-ungrouped" };
      }
      await executeWithRetry(
        () => chrome.ungroupTabs([tab.id]),
        refreshInventory,
        delay,
        shouldAbortRetry,
        onRetry
      );
      const verified = await refreshInventory();
      const verifiedTab = findTab(verified, verifyTabId);
      if (!verifiedTab || verifiedTab.chromeGroupId >= 0)
        throw new Error("Action Engine ungroup postcondition failed");
      const verifiedAt = deps.now?.() ?? Date.now();
      await moveGuardToSettling(deps, executingGuard.id, verifiedAt, []);
      await Promise.all(retryEntries);
      await recordRouteActivity(deps, plan, "success");
      return { kind: "executed", chromeGroupId: -1, inventory: verified };
    }
    const chromeGroupId = await executeWithRetry(
      () => chrome.groupTabs(plan.groupInput),
      refreshInventory,
      delay,
      shouldAbortRetry,
      onRetry
    );
    expectedChromeGroupId = chromeGroupId;
    await executeWithRetry(
      () =>
        chrome.updateGroup(chromeGroupId, {
          title: plan.title,
          color: plan.color,
          ...(plan.collapsed === undefined ? {} : { collapsed: plan.collapsed })
        }),
      refreshInventory,
      delay,
      shouldAbortRetry,
      onRetry
    );
    const verified = await refreshInventory();
    const verifiedTab = findTab(verified, verifyTabId);
    if (!verifiedTab || verifiedTab.chromeGroupId !== chromeGroupId)
      throw new Error("Action Engine postcondition failed");
    const verifiedAt = deps.now?.() ?? Date.now();
    await moveGuardToSettling(deps, executingGuard.id, verifiedAt, [chromeGroupId]);
    await Promise.all(retryEntries);
    await recordRouteActivity(deps, plan, "success");
    return { kind: "executed", chromeGroupId, inventory: verified };
  } catch (error) {
    await removeGuard(deps, executingGuard.id);
    await Promise.all(retryEntries);
    await recordRouteActivity(
      deps,
      plan,
      "failure",
      error instanceof Error ? error.message : "ROUTE_FAILED"
    );
    throw error;
  }
}

export async function settleGuardsFromSession(
  deps: Pick<RouteEngineDeps, "chrome" | "session" | "now">
) {
  const now = deps.now?.() ?? Date.now();
  const inventory = await deps.chrome.readInventory();
  const session = await deps.session.loadSession();
  const settled = settleOperationGuards(inventory, session, now);
  await deps.session.saveSession(settled);
  return settled;
}
