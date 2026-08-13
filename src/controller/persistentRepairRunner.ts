import { executeActionPlan } from "../actions/executeActionPlan";
import type { ActionEngineDeps } from "../actions/executeActionPlan";
import { buildActionPlan } from "../actions/buildActionPlan";
import type { LiveChromePort } from "../chrome/types";
import type {
  ChromeInventory,
  ChromeTabSnapshot,
  Configuration,
  RuntimeSession,
  UUID
} from "../domain/types";
import type { LocalRepository } from "../state/localRepository";
import {
  captureOwnershipDescriptor,
  ownershipFromDescriptor,
  persistentManagedGroupsInWindow
} from "../persistence/windowOwnership";
import {
  planPersistentRestore,
  planPersistentTabOrdering,
  planRepairForTab,
  repairsForClosedTab,
  type RestoreContext
} from "../persistence/startupRestore";
import {
  recordWindowClosure,
  settlePendingWindowClosures,
  STARTUP_RECOVERY_ALARM,
  WINDOW_SETTLEMENT_ALARM,
  advanceStartupSettlement,
  type AlarmScheduler
} from "../persistence/startupCoordinator";

export async function buildRestoreContext(input: {
  configuration: Configuration;
  inventory: ChromeInventory;
  session: RuntimeSession;
  local: LocalRepository;
  associations: readonly import("../domain/types").ChromeAssociation[];
}): Promise<RestoreContext> {
  const ownership = await input.local.loadWindowOwnership();
  return {
    configuration: input.configuration,
    associations: input.associations,
    ownership,
    lastFocusedWindowId: input.session.lastFocusedNormalWindowId ?? null,
    intentionallyClosedGroupIds: input.session.intentionallyClosedGroupIds
  };
}

export async function executePersistentRepairs(input: {
  repairs: import("../persistence/startupRestore").PersistentRepair[];
  actionDeps: ActionEngineDeps;
  associations: readonly import("../domain/types").ChromeAssociation[];
}): Promise<boolean> {
  const repairActions = input.repairs.flatMap((repair) => repair.actions);
  if (repairActions.length === 0) return false;

  const groupIds = [...new Set(input.repairs.map((repair) => repair.targetManagedGroupId))];
  let inventory = await input.actionDeps.reads.readInventory();
  const ordering = groupIds.flatMap((managedGroupId) => {
    const group = input.actionDeps.configuration.groups.find(
      (candidate) => candidate.id === managedGroupId
    );
    if (!group) return [];
    const association = input.associations.find(
      (candidate) => candidate.managedGroupId === managedGroupId
    );
    if (!association) return [];
    return planPersistentTabOrdering(
      group,
      input.actionDeps.configuration,
      inventory,
      input.associations,
      association.chromeWindowId
    );
  });

  const plan = buildActionPlan("reconcile", [...repairActions, ...ordering]);
  const result = await executeActionPlan(plan, input.actionDeps);
  return result.status === "success";
}

export async function runPersistentRestore(input: {
  configuration: Configuration;
  chrome: LiveChromePort;
  session: RuntimeSession;
  local: LocalRepository;
  associations: readonly import("../domain/types").ChromeAssociation[];
  actionDeps: ActionEngineDeps;
}): Promise<void> {
  const inventory = await input.chrome.readInventory();
  const context = await buildRestoreContext({
    configuration: input.configuration,
    inventory,
    session: input.session,
    local: input.local,
    associations: input.associations
  });
  const plan = planPersistentRestore(input.configuration, inventory, context);
  if (!plan) return;
  await executeActionPlan(plan, input.actionDeps);
}

export async function handleWindowLifecycleEvent(input: {
  event: import("../domain/types").ChromeEventHint;
  session: RuntimeSession;
  inventory: ChromeInventory;
  configuration: Configuration;
  associations: readonly import("../domain/types").ChromeAssociation[];
  now: number;
}): Promise<RuntimeSession> {
  let session = input.session;
  if (input.event.kind === "tabRemoved" && input.event.isWindowClosing) {
    const managedGroupIds = persistentManagedGroupsInWindow(
      input.event.windowId,
      input.configuration,
      input.inventory,
      input.associations
    );
    session = recordWindowClosure({
      session,
      windowId: input.event.windowId,
      managedGroupIds,
      tabIds: [input.event.tabId],
      now: input.now
    });
  }
  if (input.event.kind === "windowRemoved") {
    const managedGroupIds = persistentManagedGroupsInWindow(
      input.event.windowId,
      input.configuration,
      input.inventory,
      input.associations
    );
    session = recordWindowClosure({
      session,
      windowId: input.event.windowId,
      managedGroupIds,
      tabIds: [],
      now: input.now
    });
  }
  session = settlePendingWindowClosures({
    session,
    inventory: input.inventory,
    now: input.now
  });
  return session;
}

export async function handleStartupCoordinatorEvent(input: {
  event: import("../domain/types").ChromeEventHint;
  session: RuntimeSession;
  inventory: ChromeInventory;
  alarms: AlarmScheduler;
  clock: import("../persistence/startupCoordinator").StartupCoordinatorClock;
  configuration: Configuration;
  local: LocalRepository;
  associations: readonly import("../domain/types").ChromeAssociation[];
  actionDeps: ActionEngineDeps;
}): Promise<RuntimeSession> {
  if (
    input.event.kind !== "startup" &&
    input.event.kind !== "alarm" &&
    input.event.kind !== "tabCreated" &&
    input.event.kind !== "tabUpdated"
  ) {
    return input.session;
  }
  if (
    input.event.kind === "alarm" &&
    input.event.name !== STARTUP_RECOVERY_ALARM &&
    input.event.name !== WINDOW_SETTLEMENT_ALARM
  ) {
    return input.session;
  }

  const outcome = await advanceStartupSettlement({
    session: input.session,
    inventory: input.inventory,
    alarms: input.alarms,
    clock: input.clock,
    chromeEvent: input.event
  });

  if (outcome.kind === "settled") {
    await runPersistentRestore({
      configuration: input.configuration,
      chrome: input.actionDeps.reads as LiveChromePort,
      session: outcome.session,
      local: input.local,
      associations: input.associations,
      actionDeps: input.actionDeps
    });
    return { ...outcome.session, startupRestore: undefined };
  }

  return outcome.session;
}

export async function repairTabIfNeeded(input: {
  tab: ChromeTabSnapshot;
  inventory: ChromeInventory;
  session: RuntimeSession;
  configuration: Configuration;
  local: LocalRepository;
  associations: readonly import("../domain/types").ChromeAssociation[];
  actionDeps: ActionEngineDeps;
}): Promise<boolean> {
  const context = await buildRestoreContext({
    configuration: input.configuration,
    inventory: input.inventory,
    session: input.session,
    local: input.local,
    associations: input.associations
  });
  const repairs = planRepairForTab(input.tab, input.inventory, context);
  if (repairs.length === 0) return false;
  return executePersistentRepairs({
    repairs,
    actionDeps: input.actionDeps,
    associations: input.associations
  });
}

export async function repairClosedTabIfNeeded(input: {
  closedTab: ChromeTabSnapshot;
  inventory: ChromeInventory;
  session: RuntimeSession;
  configuration: Configuration;
  local: LocalRepository;
  associations: readonly import("../domain/types").ChromeAssociation[];
  actionDeps: ActionEngineDeps;
}): Promise<boolean> {
  const context = await buildRestoreContext({
    configuration: input.configuration,
    inventory: input.inventory,
    session: input.session,
    local: input.local,
    associations: input.associations
  });
  const repairs = repairsForClosedTab(
    input.closedTab,
    input.inventory,
    context
  );
  if (repairs.length === 0) return false;
  return executePersistentRepairs({
    repairs,
    actionDeps: input.actionDeps,
    associations: input.associations
  });
}

export async function updateOwnershipFromInventory(input: {
  configuration: Configuration;
  inventory: ChromeInventory;
  associations: readonly import("../domain/types").ChromeAssociation[];
  local: LocalRepository;
}): Promise<void> {
  const ownership = await input.local.loadWindowOwnership();
  const next = { ...ownership };
  for (const group of input.configuration.groups) {
    if (!group.isPersistent) continue;
    const descriptor = captureOwnershipDescriptor(
      group.id,
      group,
      input.inventory,
      input.associations
    );
    if (descriptor) next[group.id] = descriptor;
  }
  await input.local.saveWindowOwnership(next);
}

export function poisonedOwnershipIgnored(
  descriptor: import("../domain/types").WindowOwnershipDescriptor | undefined
): boolean {
  return ownershipFromDescriptor(descriptor) !== undefined;
}
