import { reconstructAssociations } from "../chrome/reconstructAssociations";
import type {
  ChromeMutationPort,
  ChromeReadPort,
  GroupTabsInput
} from "../chrome/types";
import { findTab, isRoutableUrl } from "../chrome/types";
import { buildDuplicateKey } from "../duplicates/normalizeUrl";
import { createUuid } from "../domain/ids";
import type {
  BrowserInventory,
  ChromeAssociation,
  ChromeInventory,
  Configuration,
  OperationGuard,
  TabSnapshot
} from "../domain/types";
import { tabSnapshotFromChrome } from "../persistence/windowOwnership";
import type { SessionRepository } from "../state/sessionRepository";
import type { LocalRepository } from "../state/localRepository";
import {
  buildExpectedActionFootprint,
  GUARD_HARD_MS,
  GUARD_QUIET_MS,
  postconditionHolds
} from "./operationGuards";
import { executeWithRetry, type RetryAbortReason } from "./retryPolicy";
import { createActivityEntry } from "../state/localRepository";
import { appendActivityEntry } from "../activity/activityRepository";
import type {
  ActionPlan,
  EngineActionResult,
  PlannedAction,
  TabRef
} from "./types";

function actionRetryTabIds(
  action: PlannedAction,
  outputs: EngineActionResult["outputs"],
  inventory: ChromeInventory
): number[] {
  switch (action.kind) {
    case "assignTabsToManagedGroup":
    case "assignTabsToUnmanagedGroup":
    case "moveTabs":
    case "reorderTabs":
    case "ungroupTabs":
      return action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
    case "focusTab":
      return [resolveTabRef(action.tab, outputs, inventory)].filter(
        (id): id is number => id !== undefined
      );
    case "closeDuplicate":
      return [resolveTabRef(action.duplicate, outputs, inventory)].filter(
        (id): id is number => id !== undefined
      );
    default:
      return [];
  }
}
export interface PreMutationCheckpointPort {
  captureBefore(plan: ActionPlan, inventory: BrowserInventory): Promise<void>;
}

export interface ActionEngineDeps {
  reads: ChromeReadPort;
  mutations: ChromeMutationPort;
  checkpoints: PreMutationCheckpointPort;
  local: LocalRepository;
  session: SessionRepository;
  configuration: Configuration;
  now: () => number;
  delay: (ms: number) => Promise<void>;
}

function resolveTabRef(
  ref: TabRef,
  outputs: EngineActionResult["outputs"],
  _inventory: ChromeInventory
): number | undefined {
  if (ref.kind === "live") return ref.tabId;
  const output = outputs[ref.actionId];
  if (!output || !("id" in output)) return undefined;
  return output.id;
}
function resolvedActionTabIds(
  action: PlannedAction,
  outputs: EngineActionResult["outputs"],
  inventory: ChromeInventory
): { tabIds: number[]; absentTabIds?: number[] } {
  const refs =
    action.kind === "createTab" ||
    action.kind === "restoreClosedTab" ||
    action.kind === "updateManagedGroup" ||
    action.kind === "moveManagedGroup"
      ? []
      : action.kind === "focusTab"
        ? [action.tab]
        : action.kind === "closeDuplicate"
          ? [action.duplicate, action.survivor]
          : action.tabs;
  const tabIds = refs
    .map((ref) => resolveTabRef(ref, outputs, inventory))
    .filter((id): id is number => id !== undefined);
  return action.kind === "closeDuplicate"
    ? {
        tabIds,
        absentTabIds: tabIds.length > 0 ? [tabIds[0]!] : []
      }
    : { tabIds };
}

function knownActionGroupIds(
  action: PlannedAction,
  associations: readonly ChromeAssociation[],
  inventory: ChromeInventory
): number[] {
  if (action.kind === "assignTabsToUnmanagedGroup")
    return [action.chromeGroupId];
  if (
    action.kind === "assignTabsToManagedGroup" ||
    action.kind === "updateManagedGroup" ||
    action.kind === "moveManagedGroup"
  ) {
    const managedGroupId = action.managedGroupId;
    return associations
      .filter((association) => association.managedGroupId === managedGroupId)
      .map((association) => association.chromeGroupId);
  }
  if (action.kind === "ungroupTabs") {
    return resolvedActionTabIds(action, {}, inventory)
      .tabIds.map((tabId) => findTab(inventory, tabId)?.chromeGroupId ?? -1)
      .filter((groupId) => groupId >= 0);
  }
  return [];
}

async function saveActionGuard(
  action: PlannedAction,
  actionId: ActionPlan["id"],
  deps: ActionEngineDeps,
  outputs: EngineActionResult["outputs"],
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): Promise<OperationGuard> {
  const resolved = resolvedActionTabIds(action, outputs, inventory);
  const footprint = buildExpectedActionFootprint({
    action,
    tabIds: resolved.tabIds,
    absentTabIds: resolved.absentTabIds,
    chromeGroupIds: knownActionGroupIds(action, associations, inventory),
    associations
  });
  const session = await deps.session.loadSession();
  const startedAt = deps.now();
  const guard: OperationGuard = {
    id: createUuid(),
    browserSessionId: session.browserSessionId,
    actionId,
    operation: footprint.operation,
    phase: "executing",
    tabIds: footprint.tabIds,
    chromeGroupIds: footprint.chromeGroupIds,
    expectedEventKinds: footprint.expectedEventKinds,
    seenEventKinds: [],
    postcondition: footprint.postcondition,
    pendingTab: footprint.pendingTab,
    startedAt,
    expiresAt: startedAt + GUARD_HARD_MS
  };
  await deps.session.saveSession({
    ...session,
    operationGuards: [...session.operationGuards, guard]
  });
  return guard;
}

async function finishActionGuard(
  guard: OperationGuard,
  action: PlannedAction,
  deps: ActionEngineDeps,
  outputs: EngineActionResult["outputs"],
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): Promise<boolean> {
  const resolved = resolvedActionTabIds(action, outputs, inventory);
  const output = outputs[action.id];
  const outputGroupId =
    output && "chromeGroupId" in output ? output.chromeGroupId : undefined;
  const outputTabId = output && "id" in output ? output.id : undefined;
  const tabIds =
    outputTabId === undefined
      ? resolved.tabIds
      : [...resolved.tabIds, outputTabId];
  const footprint = buildExpectedActionFootprint({
    action,
    tabIds,
    absentTabIds: resolved.absentTabIds,
    chromeGroupIds: knownActionGroupIds(action, associations, inventory),
    outputChromeGroupId: outputGroupId,
    associations
  });
  const holds = postconditionHolds(footprint.postcondition, inventory);
  const session = await deps.session.loadSession();
  const current = session.operationGuards.find(
    (candidate) => candidate.id === guard.id
  );
  if (!current) return false;
  await deps.session.saveSession({
    ...session,
    operationGuards: holds
      ? session.operationGuards.map((candidate) =>
          candidate.id === guard.id
            ? {
                ...candidate,
                phase: "settling",
                tabIds: footprint.tabIds,
                chromeGroupIds: footprint.chromeGroupIds,
                postcondition: footprint.postcondition,
                pendingTab: undefined,
                verifiedAt: deps.now(),
                settleAfter: deps.now() + GUARD_QUIET_MS
              }
            : candidate
        )
      : session.operationGuards.filter((candidate) => candidate.id !== guard.id)
  });
  return holds;
}

async function updateExecutingGroupId(
  deps: ActionEngineDeps,
  guardId: string,
  chromeGroupId: number
): Promise<void> {
  const session = await deps.session.loadSession();
  await deps.session.saveSession({
    ...session,
    operationGuards: session.operationGuards.map((guard) =>
      guard.id === guardId
        ? {
            ...guard,
            chromeGroupIds: guard.chromeGroupIds.includes(chromeGroupId)
              ? guard.chromeGroupIds
              : [...guard.chromeGroupIds, chromeGroupId],
            postcondition:
              guard.postcondition?.kind === "tabPlacement"
                ? { ...guard.postcondition, chromeGroupId }
                : guard.postcondition
          }
        : guard
    )
  });
}

function groupInputForAssign(
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[],
  action: Extract<PlannedAction, { kind: "assignTabsToManagedGroup" }>,
  tabIds: readonly number[]
): GroupTabsInput {
  const tabs = tabIds.map((tabId) => findTab(inventory, tabId));
  if (tabs.some((tab) => !tab)) throw new Error("assign tab missing");
  if (tabs.some((tab) => tab!.windowId !== action.windowId))
    throw new Error("assign tab window mismatch");
  const existing = associations.find(
    (association) =>
      association.managedGroupId === action.managedGroupId &&
      association.chromeWindowId === action.windowId
  );
  const group =
    existing &&
    inventory.groups.find(
      (candidate) =>
        candidate.id === existing.chromeGroupId &&
        candidate.windowId === action.windowId &&
        !candidate.shared
    );
  if (group) {
    return {
      kind: "existing",
      tabIds: tabIds as [number, ...number[]],
      chromeGroupId: group.id,
      windowId: action.windowId
    };
  }
  return {
    kind: "create",
    tabIds: tabIds as [number, ...number[]],
    windowId: action.windowId
  };
}
function isAutomaticPlan(plan: ActionPlan): boolean {
  return (
    plan.source !== "user" &&
    plan.source !== "undo" &&
    plan.source !== "duplicate"
  );
}

function affectedPlanData(
  plan: ActionPlan,
  inventory: ChromeInventory,
  outputs: EngineActionResult["outputs"]
) {
  const managedGroupIds = plan.actions.flatMap((action) =>
    "managedGroupId" in action ? [action.managedGroupId] : []
  );
  const tabIds = plan.actions.flatMap((action) => {
    if (action.kind === "createTab" || action.kind === "restoreClosedTab")
      return [];
    if (action.kind === "focusTab")
      return [resolveTabRef(action.tab, outputs, inventory)];
    if (action.kind === "closeDuplicate")
      return [
        resolveTabRef(action.duplicate, outputs, inventory),
        resolveTabRef(action.survivor, outputs, inventory)
      ];
    if ("tabs" in action)
      return action.tabs.map((ref) => resolveTabRef(ref, outputs, inventory));
    return [];
  });
  const urls = tabIds
    .filter((id): id is number => id !== undefined)
    .map((id) => findTab(inventory, id)?.url)
    .filter((url): url is string => !!url);
  return {
    managedGroupIds: [...new Set(managedGroupIds)],
    urls: [...new Set(urls)]
  };
}

async function recordAutomaticPlanActivity(
  deps: ActionEngineDeps,
  plan: ActionPlan,
  result: {
    actionId: EngineActionResult["actionId"];
    status: "success" | "retry" | "degraded" | "failure";
    completed: EngineActionResult["completed"];
    outputs: EngineActionResult["outputs"];
    errorCode?: string;
  },
  inventory: ChromeInventory
): Promise<void> {
  if (!isAutomaticPlan(plan)) return;
  const affected = affectedPlanData(plan, inventory, result.outputs);
  await appendActivityEntry(
    deps.local,
    createActivityEntry({
      action: `Automatic ${plan.source} plan`,
      result: result.status,
      affectedManagedGroupIds: affected.managedGroupIds,
      affectedUrls: affected.urls,
      actionId: plan.id,
      source: plan.source,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      createdAt: deps.now()
    })
  );
}

export async function executeActionPlan(
  plan: ActionPlan,
  deps: ActionEngineDeps
): Promise<EngineActionResult> {
  const outputs: EngineActionResult["outputs"] = {};
  const completed: EngineActionResult["completed"] = [];
  let inventory = await deps.reads.readInventory();
  let associations = reconstructAssociations(inventory, deps.configuration);
  const session = await deps.session.loadSession();
  const retryEntries: Promise<void>[] = [];
  async function finish(
    result: EngineActionResult
  ): Promise<EngineActionResult> {
    await Promise.all(retryEntries);
    await recordAutomaticPlanActivity(deps, plan, result, inventory);
    return result;
  }

  if (plan.checkpoint === "required") {
    try {
      await deps.checkpoints.captureBefore(
        plan,
        decorateInventory(inventory, session)
      );
    } catch {
      return await finish({
        actionId: plan.id,
        status: "failure",
        completed: [],
        outputs: {},
        errorCode: "CHECKPOINT_FAILED"
      });
    }
  }

  for (const action of plan.actions) {
    const closeDuplicateId =
      action.kind === "closeDuplicate"
        ? resolveTabRef(action.duplicate, outputs, inventory)
        : undefined;
    const sharedNoOp =
      closeDuplicateId !== undefined &&
      inventory.groups.find(
        (group) =>
          group.id === findTab(inventory, closeDuplicateId)?.chromeGroupId
      )?.shared === true;
    const guard = sharedNoOp
      ? undefined
      : await saveActionGuard(
          action,
          plan.id,
          deps,
          outputs,
          inventory,
          associations
        );
    let result: PlannedActionExecutionResult;
    try {
      result = await executePlannedAction(action, {
        deps,
        plan,
        outputs,
        inventory,
        associations,
        guardId: guard?.id,
        onRetry: () => {
          retryEntries.push(
            recordAutomaticPlanActivity(
              deps,
              plan,
              { actionId: plan.id, status: "retry", completed, outputs },
              inventory
            )
          );
        }
      });
    } catch (error) {
      if (guard) {
        const sessionAfterFailure = await deps.session.loadSession();
        await deps.session.saveSession({
          ...sessionAfterFailure,
          operationGuards: sessionAfterFailure.operationGuards.filter(
            (candidate) => candidate.id !== guard.id
          )
        });
      }
      return await finish({
        actionId: plan.id,
        status: completed.length > 0 ? "degraded" : "failure",
        completed,
        outputs,
        errorCode: error instanceof Error ? error.message : "ACTION_FAILED"
      });
    }
    if (result.status === "failure") {
      if (guard) {
        const sessionAfterFailure = await deps.session.loadSession();
        await deps.session.saveSession({
          ...sessionAfterFailure,
          operationGuards: sessionAfterFailure.operationGuards.filter(
            (candidate) => candidate.id !== guard.id
          )
        });
      }
      return await finish({
        actionId: plan.id,
        status: completed.length > 0 ? "degraded" : "failure",
        completed,
        outputs,
        errorCode: result.errorCode
      });
    }
    if (result.output) outputs[action.id] = result.output;
    inventory = await deps.reads.readInventory();
    associations = reconstructAssociations(inventory, deps.configuration);
    if (guard) {
      const holds = await finishActionGuard(
        guard,
        action,
        deps,
        outputs,
        inventory,
        associations
      );
      if (!holds) {
        return await finish({
          actionId: plan.id,
          status: completed.length > 0 ? "degraded" : "failure",
          completed,
          outputs,
          errorCode: "POSTCONDITION_FAILED"
        });
      }
    }
    completed.push(action.id);
  }

  return await finish({
    actionId: plan.id,
    status: "success",
    completed,
    outputs
  });
}

function decorateInventory(
  inventory: ChromeInventory,
  _session: import("../domain/types").RuntimeSession
): BrowserInventory {
  return {
    ...inventory,
    tabs: inventory.tabs.map((tab) => ({
      ...tab,
      routing: isRoutableUrl(tab.url)
        ? { kind: "routable" as const, url: tab.url }
        : { kind: "pending" as const }
    }))
  };
}
export interface PlannedActionExecutionResult {
  status: "success" | "failure";
  output?: TabSnapshot | { chromeGroupId: number };
  errorCode?: string;
}

async function executePlannedAction(
  action: PlannedAction,
  context: {
    deps: ActionEngineDeps;
    plan: ActionPlan;
    outputs: EngineActionResult["outputs"];
    inventory: ChromeInventory;
    associations: ChromeAssociation[];
    guardId?: string;
    onRetry?: (attempt: number) => void;
  }
): Promise<PlannedActionExecutionResult> {
  const { deps, outputs, inventory, associations, guardId, onRetry } = context;
  const delay = deps.delay;
  async function refresh() {
    return deps.reads.readInventory();
  }
  function buildRetryPredicate(
    retryAction: PlannedAction,
    baselineInventory: ChromeInventory
  ): (refreshed: unknown) => RetryAbortReason | undefined {
    const retryTabIds = actionRetryTabIds(
      retryAction,
      outputs,
      baselineInventory
    );
    const managedAssociation =
      retryAction.kind === "assignTabsToManagedGroup" ||
      retryAction.kind === "updateManagedGroup" ||
      retryAction.kind === "moveManagedGroup"
        ? associations.find(
            (candidate) =>
              candidate.managedGroupId === retryAction.managedGroupId
          )
        : undefined;
    const targetChromeGroupId =
      retryAction.kind === "assignTabsToManagedGroup"
        ? managedAssociation?.chromeGroupId
        : undefined;
    const retryGroupIds = [
      ...(retryAction.kind === "assignTabsToUnmanagedGroup"
        ? [retryAction.chromeGroupId]
        : []),
      ...(managedAssociation?.chromeGroupId === undefined
        ? []
        : [managedAssociation.chromeGroupId])
    ];
    const retryBaseline = new Map(
      retryTabIds.flatMap((tabId) => {
        const tab = findTab(baselineInventory, tabId);
        return tab ? [[tabId, tab] as const] : [];
      })
    );
    const retryBaselineGroups = new Map(
      retryGroupIds.flatMap((groupId) => {
        const group = baselineInventory.groups.find(
          (candidate) => candidate.id === groupId
        );
        return group ? [[groupId, group] as const] : [];
      })
    );
    const retryFootprint = buildExpectedActionFootprint({
      action: retryAction,
      tabIds: retryTabIds,
      chromeGroupIds: retryGroupIds,
      outputChromeGroupId: targetChromeGroupId
    });
    return (refreshed: unknown): RetryAbortReason | undefined => {
      const next = refreshed as ChromeInventory;
      for (const tabId of retryTabIds) {
        if (!findTab(next, tabId)) {
          return retryFootprint.postcondition?.kind === "tabsAbsent" &&
            postconditionHolds(retryFootprint.postcondition, next)
            ? "satisfied"
            : "gone";
        }
      }
      const changedTab = retryTabIds.some((tabId) => {
        const before = retryBaseline.get(tabId);
        const after = findTab(next, tabId);
        return (
          before !== undefined &&
          after !== undefined &&
          (before.windowId !== after.windowId ||
            before.index !== after.index ||
            before.chromeGroupId !== after.chromeGroupId)
        );
      });
      const changedGroup = retryGroupIds.some((groupId) => {
        const before = retryBaselineGroups.get(groupId);
        const after = next.groups.find((candidate) => candidate.id === groupId);
        return (
          before !== undefined &&
          after !== undefined &&
          (before.windowId !== after.windowId ||
            before.title !== after.title ||
            before.color !== after.color ||
            before.collapsed !== after.collapsed)
        );
      });
      const holds = postconditionHolds(retryFootprint.postcondition, next);
      if (holds && retryAction.kind === "closeDuplicate") return "satisfied";
      if (!changedTab && !changedGroup) return undefined;
      return "contradiction";
    };
  }
  const shouldAbortRetry = buildRetryPredicate(action, inventory);

  switch (action.kind) {
    case "createTab": {
      const tabId = await executeWithRetry(
        () =>
          deps.mutations.createTab({
            url: action.input.url,
            windowId: action.input.windowId,
            active: action.input.active ?? false,
            index: action.input.index
          }),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      const after = await refresh();
      const tab = findTab(after, tabId);
      if (!tab) return { status: "failure", errorCode: "TAB_MISSING" };
      return { status: "success", output: tab };
    }
    case "restoreClosedTab": {
      const tabId = await executeWithRetry(
        () => deps.mutations.restoreClosedTab(action.sessionId),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      const after = await refresh();
      const tab = findTab(after, tabId);
      if (!tab) return { status: "failure", errorCode: "TAB_MISSING" };
      return { status: "success", output: tab };
    }
    case "moveTabs": {
      const tabIds = action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
      if (tabIds.length === 0)
        return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.moveTabs(
            tabIds as [number, ...number[]],
            action.windowId,
            action.index
          ),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      return { status: "success" };
    }
    case "assignTabsToManagedGroup": {
      const tabIds = action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
      if (tabIds.length === 0)
        return { status: "failure", errorCode: "TAB_MISSING" };
      const input = groupInputForAssign(
        inventory,
        associations,
        action,
        tabIds
      );
      const chromeGroupId = await executeWithRetry(
        () => deps.mutations.groupTabs(input),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      if (guardId) {
        await updateExecutingGroupId(deps, guardId, chromeGroupId);
      }
      const updateBaseline = await refresh();
      const updateAction: PlannedAction = {
        id: action.id,
        dependsOn: [],
        kind: "updateManagedGroup",
        managedGroupId: action.managedGroupId,
        patch: {
          title: action.title,
          color: action.color,
          ...(action.collapsed === undefined
            ? {}
            : { collapsed: action.collapsed })
        }
      };
      const updateShouldAbortRetry = buildRetryPredicate(
        updateAction,
        updateBaseline
      );
      await executeWithRetry(
        () =>
          deps.mutations.updateGroup(chromeGroupId, {
            title: action.title,
            color: action.color,
            ...(action.collapsed === undefined
              ? {}
              : { collapsed: action.collapsed })
          }),
        refresh,
        delay,
        updateShouldAbortRetry,
        onRetry
      );
      return { status: "success", output: { chromeGroupId } };
    }
    case "ungroupTabs": {
      const tabIds = action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
      if (tabIds.length === 0)
        return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () => deps.mutations.ungroupTabs(tabIds as [number, ...number[]]),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      return { status: "success" };
    }
    case "focusTab": {
      const tabId = resolveTabRef(action.tab, outputs, inventory);
      if (tabId === undefined)
        return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () => deps.mutations.focusTab(tabId, action.windowId),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      return { status: "success" };
    }
    case "closeDuplicate": {
      const duplicateId = resolveTabRef(action.duplicate, outputs, inventory);
      const survivorId = resolveTabRef(action.survivor, outputs, inventory);
      if (duplicateId === undefined || survivorId === undefined) {
        return { status: "failure", errorCode: "TAB_MISSING" };
      }
      const fresh = await refresh();
      const duplicate = findTab(fresh, duplicateId);
      const survivor = findTab(fresh, survivorId);
      if (!duplicate || !survivor) {
        return { status: "failure", errorCode: "TAB_MISSING" };
      }
      const duplicateGroup = fresh.groups.find(
        (group) => group.id === duplicate.chromeGroupId
      );
      if (duplicateGroup?.shared) {
        return { status: "success" };
      }
      if (!duplicate.url || !isRoutableUrl(duplicate.url)) {
        return { status: "success" };
      }
      if (!survivor.url || !isRoutableUrl(survivor.url)) {
        return { status: "success" };
      }
      const duplicateKey = buildDuplicateKey(
        tabSnapshotFromChrome(duplicate),
        action.duplicatePolicy,
        deps.configuration.duplicateSettings
      );
      const survivorKey = buildDuplicateKey(
        tabSnapshotFromChrome(survivor),
        action.duplicatePolicy,
        deps.configuration.duplicateSettings
      );
      if (
        duplicateKey !== action.expectedDuplicateKey ||
        survivorKey !== action.expectedDuplicateKey
      ) {
        return { status: "success" };
      }
      try {
        await executeWithRetry(
          () => deps.mutations.removeTabs([duplicateId]),
          refresh,
          delay,
          shouldAbortRetry,
          onRetry,
          () => undefined
        );
      } catch {
        return { status: "failure", errorCode: "CLOSE_FAILED" };
      }
      return { status: "success" };
    }
    case "assignTabsToUnmanagedGroup": {
      const tabIds = action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
      if (tabIds.length === 0)
        return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.groupTabs({
            kind: "existing",
            tabIds: tabIds as [number, ...number[]],
            chromeGroupId: action.chromeGroupId,
            windowId: action.windowId
          }),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      return { status: "success" };
    }
    case "updateManagedGroup": {
      const association = associations.find(
        (candidate) => candidate.managedGroupId === action.managedGroupId
      );
      if (!association)
        return { status: "failure", errorCode: "GROUP_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.updateGroup(association.chromeGroupId, action.patch),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      return { status: "success" };
    }
    case "moveManagedGroup": {
      const association = associations.find(
        (candidate) => candidate.managedGroupId === action.managedGroupId
      );
      if (!association)
        return { status: "failure", errorCode: "GROUP_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.moveGroup(
            association.chromeGroupId,
            action.windowId,
            action.index
          ),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      return { status: "success" };
    }
    case "reorderTabs": {
      const tabIds = action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
      if (tabIds.length === 0)
        return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.moveTabs(
            tabIds as [number, ...number[]],
            action.windowId,
            action.index
          ),
        refresh,
        delay,
        shouldAbortRetry,
        onRetry
      );
      return { status: "success" };
    }
    default:
      return { status: "failure", errorCode: "UNSUPPORTED" };
  }
}
