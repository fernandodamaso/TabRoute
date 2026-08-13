import { reconstructAssociations } from "../chrome/reconstructAssociations";
import type { ChromeMutationPort } from "../chrome/types";
import { findTab, isRoutableUrl } from "../chrome/types";
import { createUuid } from "../domain/ids";
import type {
  ActionId,
  BrowserSessionId,
  OperationGuard,
  UUID
} from "../domain/types";
import type { SessionRepository } from "../state/sessionRepository";
import {
  GUARD_HARD_MS,
  GUARD_QUIET_MS,
  buildExpectedFootprint,
  settleOperationGuards
} from "./operationGuards";
import { executeWithRetry } from "./retryPolicy";
import type { ActionPlan, ActionResult } from "./types";

export interface ActionEngineDeps {
  chrome: ChromeMutationPort;
  session: SessionRepository;
  now?: () => number;
  createId?: () => UUID;
  delay?: (ms: number) => Promise<void>;
}

function createGuard(input: {
  plan: ActionPlan;
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

async function saveExecutingGuard(
  deps: ActionEngineDeps,
  plan: ActionPlan,
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
  deps: ActionEngineDeps,
  guardId: UUID,
  startedAt: number,
  now: number,
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
            verifiedAt: now,
            settleAfter: now + GUARD_QUIET_MS,
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

async function removeGuard(deps: ActionEngineDeps, guardId: UUID) {
  const session = await deps.session.loadSession();
  await deps.session.saveSession({
    ...session,
    operationGuards: session.operationGuards.filter(
      (guard) => guard.id !== guardId
    )
  });
}

export async function executeActionPlan(
  plan: ActionPlan,
  deps: ActionEngineDeps
): Promise<ActionResult> {
  const now = deps.now?.() ?? Date.now();
  const createId = deps.createId ?? createUuid;
  const delay = deps.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const actionId = createId() as unknown as import("../domain/types").ActionId;
  const chrome = deps.chrome;

  const fresh = await chrome.readInventory();
  const tab = findTab(fresh, plan.tab.id);
  if (!tab || tab.incognito) return { kind: "held", reason: "incognito" };
  if (!isRoutableUrl(tab.url)) return { kind: "held", reason: "not-routable" };

  const executingGuard = await saveExecutingGuard(
    deps,
    plan,
    actionId,
    now,
    createId
  );

  try {
    if (plan.kind === "ungroup") {
      if (tab.chromeGroupId < 0) {
        await removeGuard(deps, executingGuard.id);
        return { kind: "noop", reason: "already-ungrouped" };
      }
      await executeWithRetry(
        () => chrome.ungroupTabs([tab.id]),
        () => chrome.readInventory(),
        delay
      );
      const verified = await chrome.readInventory();
      const verifiedTab = findTab(verified, tab.id);
      if (!verifiedTab || verifiedTab.chromeGroupId >= 0)
        throw new Error("Action Engine ungroup postcondition failed");
      await moveGuardToSettling(deps, executingGuard.id, now, now, []);
      return { kind: "executed", chromeGroupId: -1, inventory: verified };
    }

    const chromeGroupId = await executeWithRetry(
      () => chrome.groupTabs(plan.groupInput),
      () => chrome.readInventory(),
      delay
    );
    await executeWithRetry(
      () =>
        chrome.updateGroup(chromeGroupId, {
          title: plan.title,
          color: plan.color,
          ...(plan.collapsed === undefined ? {} : { collapsed: plan.collapsed })
        }),
      () => chrome.readInventory(),
      delay
    );
    const verified = await chrome.readInventory();
    const verifiedTab = findTab(verified, tab.id);
    if (!verifiedTab || verifiedTab.chromeGroupId !== chromeGroupId)
      throw new Error("Action Engine postcondition failed");
    await moveGuardToSettling(
      deps,
      executingGuard.id,
      now,
      now,
      [chromeGroupId]
    );
    return { kind: "executed", chromeGroupId, inventory: verified };
  } catch (error) {
    await removeGuard(deps, executingGuard.id);
    throw error;
  }
}

export async function settleGuardsFromSession(
  deps: Pick<ActionEngineDeps, "chrome" | "session" | "now">
) {
  const now = deps.now?.() ?? Date.now();
  const inventory = await deps.chrome.readInventory();
  const session = await deps.session.loadSession();
  const settled = settleOperationGuards(inventory, session, now);
  await deps.session.saveSession(settled);
  return settled;
}

export { reconstructAssociations };
