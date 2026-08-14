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
import {
  createActivityEntry,
  type LocalRepository
} from "../state/localRepository";
import type { Configuration } from "../domain/types";
import type { SessionRepository } from "../state/sessionRepository";
import {
  GUARD_HARD_MS,
  GUARD_QUIET_MS,
  buildExpectedFootprint,
  settleOperationGuards
} from "./operationGuards";
import { executeWithRetry } from "./retryPolicy";
import { translateRoutePlan } from "./translateRoutePlan";
import { observeInventory } from "../duplicates/observations";
import type { PreMutationCheckpointPort } from "../snapshots/checkpointService";
import type { RoutePlan, RouteResult } from "./types";
export interface RouteEngineDeps {
  chrome: ChromeReadPort & ChromeMutationPort;
  session: SessionRepository;
  checkpoints: PreMutationCheckpointPort;
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
  const delay =
    deps.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const actionId = createId() as unknown as ActionId;
  const chrome = deps.chrome;

  const fresh = await chrome.readInventory();
  const tab = findTab(fresh, plan.tab.id);
  if (!tab || tab.incognito) return { kind: "held", reason: "incognito" };
  if (!isRoutableUrl(tab.url)) return { kind: "held", reason: "not-routable" };
  if (plan.kind === "ungroup") {
    try {
      const session = await deps.session.loadSession();
      const observed = observeInventory(fresh, session);
      await deps.session.saveSession(observed.session);
      await deps.checkpoints.captureBefore(
        translateRoutePlan(plan),
        observed.inventory
      );
    } catch (error) {
      await recordRouteActivity(
        deps,
        plan,
        "failure",
        error instanceof Error ? error.message : "CHECKPOINT_FAILED"
      );
      throw error;
    }
  }
  const retryEntries: Promise<void>[] = [];
  const onRetry = () => {
    retryEntries.push(recordRouteActivity(deps, plan, "retry"));
  };
  const executingGuard = await saveExecutingGuard(
    deps,
    plan,
    actionId,
    now,
    createId
  );

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

  type PlacementBaseline = {
    windowId: number;
    index: number;
    chromeGroupId: number;
  };

  function placementBaseline(inventory: ChromeInventory): PlacementBaseline {
    const subject = findTab(inventory, verifyTabId);
    if (!subject) throw new Error("No tab with id");
    return {
      windowId: subject.windowId,
      index: subject.index,
      chromeGroupId: subject.chromeGroupId
    };
  }

  function placementRetry(
    baseline: PlacementBaseline,
    expectedGroupId?: number
  ) {
    let recoveredGroupId: number | undefined;
    const predicate = (refreshed: unknown) => {
      const inventory = refreshed as ChromeInventory;
      const subject = findTab(inventory, verifyTabId);
      if (!subject) return "gone" as const;

      const satisfied =
        plan.kind === "ungroup"
          ? subject.chromeGroupId < 0
          : expectedGroupId !== undefined
            ? subject.chromeGroupId === expectedGroupId
            : plan.groupInput.kind === "create" &&
              subject.chromeGroupId >= 0 &&
              subject.chromeGroupId !== baseline.chromeGroupId;
      if (satisfied) {
        if (plan.kind !== "ungroup") recoveredGroupId = subject.chromeGroupId;
        return "satisfied" as const;
      }

      const changed =
        subject.windowId !== baseline.windowId ||
        subject.index !== baseline.index ||
        subject.chromeGroupId !== baseline.chromeGroupId;
      return changed ? ("contradiction" as const) : undefined;
    };
    return {
      predicate,
      recover: () => recoveredGroupId
    };
  }

  try {
    if (plan.kind === "ungroup") {
      if (tab.chromeGroupId < 0) {
        await removeGuard(deps, executingGuard.id);
        return { kind: "noop", reason: "already-ungrouped" };
      }
      const baseline = placementBaseline(await refreshInventory());
      const retry = placementRetry(baseline);
      await executeWithRetry(
        () => chrome.ungroupTabs([tab.id]),
        refreshInventory,
        delay,
        retry.predicate,
        onRetry,
        () => undefined
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

    const baseline = placementBaseline(await refreshInventory());
    const expectedGroupId =
      plan.groupInput.kind === "existing"
        ? plan.groupInput.chromeGroupId
        : undefined;
    const retry = placementRetry(baseline, expectedGroupId);
    const chromeGroupId = await executeWithRetry(
      () => chrome.groupTabs(plan.groupInput),
      refreshInventory,
      delay,
      retry.predicate,
      onRetry,
      () => {
        const recovered = retry.recover();
        if (recovered === undefined)
          throw new Error("Action Engine recovery group unavailable");
        return recovered;
      }
    );

    const updateBaselineInventory = await refreshInventory();
    const updateGroup = updateBaselineInventory.groups.find(
      (group) => group.id === chromeGroupId
    );
    if (!updateGroup) throw new Error("Action Engine group missing");
    const updateRetry = (refreshed: unknown) => {
      const inventory = refreshed as ChromeInventory;
      const group = inventory.groups.find(
        (candidate) => candidate.id === chromeGroupId
      );
      if (!group) return "gone" as const;
      const holds =
        group.title === plan.title &&
        group.color === plan.color &&
        (plan.collapsed === undefined || group.collapsed === plan.collapsed);
      if (holds) return "satisfied" as const;
      const changed =
        group.title !== updateGroup.title ||
        group.color !== updateGroup.color ||
        group.collapsed !== updateGroup.collapsed;
      return changed ? ("contradiction" as const) : undefined;
    };
    await executeWithRetry(
      () =>
        chrome.updateGroup(chromeGroupId, {
          title: plan.title,
          color: plan.color,
          ...(plan.collapsed === undefined ? {} : { collapsed: plan.collapsed })
        }),
      refreshInventory,
      delay,
      updateRetry,
      onRetry,
      () => undefined
    );
    const verified = await refreshInventory();
    const verifiedTab = findTab(verified, verifyTabId);
    if (!verifiedTab || verifiedTab.chromeGroupId !== chromeGroupId)
      throw new Error("Action Engine postcondition failed");
    const verifiedAt = deps.now?.() ?? Date.now();
    await moveGuardToSettling(deps, executingGuard.id, verifiedAt, [
      chromeGroupId
    ]);
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
