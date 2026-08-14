import { createUuid } from "../domain/ids";
import { isRoutableUrl } from "../chrome/types";
import { renderGroupTitle } from "../groups/displayTitle";
import { buildActionPlan } from "../actions/buildActionPlan";
import type { ActionPlan, PlannedAction, TabRef } from "../actions/types";
import type {
  ActionId,
  ChromeAssociation,
  ChromeInventory,
  ChromeTabSnapshot,
  Configuration,
  ManagedGroup,
  PersistentTab,
  TabSnapshot,
  UUID,
  WindowOwnershipDescriptor
} from "../domain/types";
import { matchesAcceptedUrl } from "./acceptedUrl";
import {
  isGroupEligibleForRepair,
  isTabInSharedGroup,
  managedGroupIdForTab,
  matchesPersistentDefinition,
  persistentTabsForGroup,
  tabUrl
} from "./requirements";
import { resolveHomeWindow, tabSnapshotFromChrome } from "./windowOwnership";

export interface RestoreContext {
  configuration: Configuration;
  associations: readonly ChromeAssociation[];
  ownership: Record<UUID, WindowOwnershipDescriptor>;
  lastFocusedWindowId: number | null;
  intentionallyClosedGroupIds: readonly UUID[];
}

export interface PersistentRepair {
  definitionId: UUID;
  action: "recreate" | "return" | "reclassifyAndRecreate";
  targetManagedGroupId: UUID;
  actions: PlannedAction[];
}

function actionId(): ActionId {
  return createUuid() as unknown as ActionId;
}

function tabRef(tabId: number): TabRef {
  return { kind: "live", tabId };
}

function outputRef(actionIdValue: ActionId): TabRef {
  return { kind: "actionOutput", actionId: actionIdValue };
}

function managedGroupFor(
  configuration: Configuration,
  managedGroupId: UUID
): ManagedGroup | undefined {
  return configuration.groups.find((group) => group.id === managedGroupId);
}

function findTabInManagedGroup(
  definition: PersistentTab,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): ChromeTabSnapshot | undefined {
  const association = associations.find(
    (candidate) => candidate.managedGroupId === definition.managedGroupId
  );
  if (!association) return undefined;
  return inventory.tabs.find(
    (tab) =>
      tab.windowId === association.chromeWindowId &&
      tab.chromeGroupId === association.chromeGroupId &&
      !tab.incognito &&
      isRoutableUrl(tab.url) &&
      !isTabInSharedGroup(tab, inventory)
  );
}

function findMatchingNonSharedTab(
  definition: PersistentTab,
  inventory: ChromeInventory
): ChromeTabSnapshot | undefined {
  for (const tab of inventory.tabs) {
    if (isTabInSharedGroup(tab, inventory)) continue;
    const snapshot = tabSnapshotFromChrome(tab);
    if (matchesPersistentDefinition(snapshot, definition)) return tab;
  }
  return undefined;
}

function isInTargetManagedGroup(
  tab: ChromeTabSnapshot,
  definition: PersistentTab,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): boolean {
  return (
    managedGroupIdForTab(tab, inventory, associations) ===
    definition.managedGroupId
  );
}

function buildAssignAction(
  tabRefValue: TabRef,
  managedGroup: ManagedGroup,
  windowId: number,
  id: ActionId
): PlannedAction {
  return {
    id,
    dependsOn:
      tabRefValue.kind === "actionOutput" ? [tabRefValue.actionId] : [],
    kind: "assignTabsToManagedGroup",
    tabs: [tabRefValue],
    managedGroupId: managedGroup.id,
    windowId,
    title: renderGroupTitle(managedGroup),
    color: managedGroup.color,
    collapsed: managedGroup.defaultCollapsed
  };
}

function buildRecreateActions(
  definition: PersistentTab,
  managedGroup: ManagedGroup,
  windowId: number
): PlannedAction[] {
  const createId = actionId();
  const assignId = actionId();
  return [
    {
      id: createId,
      dependsOn: [],
      kind: "createTab",
      input: {
        url: definition.canonicalUrl,
        windowId,
        active: false
      }
    },
    buildAssignAction(outputRef(createId), managedGroup, windowId, assignId)
  ];
}

function buildReturnActions(
  tab: ChromeTabSnapshot,
  managedGroup: ManagedGroup,
  windowId: number
): PlannedAction[] {
  const assignId = actionId();
  return [buildAssignAction(tabRef(tab.id), managedGroup, windowId, assignId)];
}

export function calculatePersistentRepairs(
  definition: PersistentTab,
  inventory: ChromeInventory,
  context: RestoreContext,
  homeWindow: number
): PersistentRepair[] {
  const managedGroup = managedGroupFor(
    context.configuration,
    definition.managedGroupId
  );
  if (
    !managedGroup ||
    !isGroupEligibleForRepair(
      context.configuration,
      definition.managedGroupId,
      context.intentionallyClosedGroupIds
    )
  ) {
    return [];
  }

  const matchingTab = findMatchingNonSharedTab(definition, inventory);

  if (matchingTab) {
    const url = matchingTab.url ?? "";
    const canonicalMatch =
      url === definition.canonicalUrl ||
      matchesAcceptedUrl(
        url,
        definition.canonicalUrl,
        definition.acceptedPatterns
      );
    const inCorrectGroup = isInTargetManagedGroup(
      matchingTab,
      definition,
      inventory,
      context.associations
    );

    if (!canonicalMatch) {
      return [
        {
          definitionId: definition.id,
          action: "reclassifyAndRecreate",
          targetManagedGroupId: definition.managedGroupId,
          actions: buildRecreateActions(definition, managedGroup, homeWindow)
        }
      ];
    }

    if (!inCorrectGroup) {
      return [
        {
          definitionId: definition.id,
          action: "return",
          targetManagedGroupId: definition.managedGroupId,
          actions: buildReturnActions(matchingTab, managedGroup, homeWindow)
        }
      ];
    }

    return [];
  }

  const inGroupTab = findTabInManagedGroup(
    definition,
    inventory,
    context.associations
  );
  if (inGroupTab) {
    return [
      {
        definitionId: definition.id,
        action: "reclassifyAndRecreate",
        targetManagedGroupId: definition.managedGroupId,
        actions: buildRecreateActions(definition, managedGroup, homeWindow)
      }
    ];
  }

  return [
    {
      definitionId: definition.id,
      action: "recreate",
      targetManagedGroupId: definition.managedGroupId,
      actions: buildRecreateActions(definition, managedGroup, homeWindow)
    }
  ];
}

export function planRepairForTab(
  tab: ChromeTabSnapshot,
  inventory: ChromeInventory,
  context: RestoreContext
): PersistentRepair[] {
  const repairs: PersistentRepair[] = [];
  const snapshot = tabSnapshotFromChrome(tab);
  const url = tabUrl(snapshot);
  if (!url) return repairs;

  for (const definition of context.configuration.persistentTabs) {
    if (
      !isGroupEligibleForRepair(
        context.configuration,
        definition.managedGroupId,
        context.intentionallyClosedGroupIds
      )
    ) {
      continue;
    }
    const homeWindow = resolveHomeWindow(
      context.ownership[definition.managedGroupId],
      inventory,
      [tab.id],
      context.lastFocusedWindowId
    );
    if (homeWindow === null) continue;

    const inTargetGroup = isInTargetManagedGroup(
      tab,
      definition,
      inventory,
      context.associations
    );
    if (!matchesPersistentDefinition(snapshot, definition) && !inTargetGroup) {
      continue;
    }

    repairs.push(
      ...calculatePersistentRepairs(definition, inventory, context, homeWindow)
    );
  }
  return repairs;
}

export function planPersistentTabOrdering(
  group: ManagedGroup,
  configuration: Configuration,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[],
  windowId: number
): PlannedAction[] {
  const association = associations.find(
    (candidate) =>
      candidate.managedGroupId === group.id &&
      candidate.chromeWindowId === windowId
  );
  if (!association) return [];

  const definitions = persistentTabsForGroup(configuration, group.id);
  if (definitions.length === 0) return [];

  const groupTabs = inventory.tabs
    .filter(
      (tab) =>
        tab.windowId === windowId &&
        tab.chromeGroupId === association.chromeGroupId
    )
    .sort((left, right) => left.index - right.index);

  const actions: PlannedAction[] = [];
  let targetIndex = 0;

  for (const definition of definitions) {
    const tab = groupTabs.find((candidate) => {
      if (isTabInSharedGroup(candidate, inventory)) return false;
      return matchesPersistentDefinition(
        tabSnapshotFromChrome(candidate),
        definition
      );
    });
    if (!tab) continue;
    if (tab.index !== targetIndex) {
      actions.push({
        id: actionId(),
        dependsOn: [],
        kind: "reorderTabs",
        tabs: [tabRef(tab.id)],
        windowId,
        index: targetIndex
      });
    }
    targetIndex += 1;
  }

  return actions;
}

export function planPersistentRestore(
  configuration: Configuration,
  inventory: ChromeInventory,
  context: RestoreContext
): ActionPlan | null {
  if (!configuration.restorePersistentGroups) return null;

  const actions: PlannedAction[] = [];
  const persistentGroups = configuration.groups.filter(
    (group) => group.isPersistent && group.enabled && !group.isFallback
  );

  for (const group of persistentGroups) {
    if (context.intentionallyClosedGroupIds.includes(group.id)) continue;
    const homeWindow = resolveHomeWindow(
      context.ownership[group.id],
      inventory,
      [],
      context.lastFocusedWindowId
    );
    if (homeWindow === null) continue;

    for (const definition of persistentTabsForGroup(configuration, group.id)) {
      const repairs = calculatePersistentRepairs(
        definition,
        inventory,
        context,
        homeWindow
      );
      for (const repair of repairs) {
        actions.push(...repair.actions);
      }
    }

    actions.push(
      ...planPersistentTabOrdering(
        group,
        configuration,
        inventory,
        context.associations,
        homeWindow
      )
    );

    const association = context.associations.find(
      (candidate) => candidate.managedGroupId === group.id
    );
    const ownership = context.ownership[group.id];
    if (association && ownership) {
      const moveId = actionId();
      actions.push({
        id: moveId,
        dependsOn: [],
        kind: "moveManagedGroup",
        managedGroupId: group.id,
        windowId: homeWindow,
        index: ownership.order
      });
      const updateId = actionId();
      actions.push({
        id: updateId,
        dependsOn: [],
        kind: "updateManagedGroup",
        managedGroupId: group.id,
        patch: { collapsed: ownership.collapsed }
      });
    }
  }

  if (actions.length === 0) return null;
  return buildActionPlan("reconcile", actions);
}

export function repairsForClosedTab(
  closedTab: ChromeTabSnapshot,
  inventory: ChromeInventory,
  context: RestoreContext
): PersistentRepair[] {
  const snapshot = tabSnapshotFromChrome(closedTab);
  const repairs: PersistentRepair[] = [];
  for (const definition of context.configuration.persistentTabs) {
    if (!matchesPersistentDefinition(snapshot, definition)) continue;
    if (
      !isGroupEligibleForRepair(
        context.configuration,
        definition.managedGroupId,
        context.intentionallyClosedGroupIds
      )
    ) {
      continue;
    }
    const homeWindow = resolveHomeWindow(
      context.ownership[definition.managedGroupId],
      inventory,
      [],
      context.lastFocusedWindowId
    );
    if (homeWindow === null) continue;
    repairs.push(
      ...calculatePersistentRepairs(definition, inventory, context, homeWindow)
    );
  }
  return repairs;
}

export function toTabSnapshot(tab: ChromeTabSnapshot): TabSnapshot {
  return tabSnapshotFromChrome(tab);
}
