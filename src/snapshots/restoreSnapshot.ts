import { createUuid } from "../domain/ids";
import { renderGroupTitle } from "../groups/displayTitle";
import { selectDuplicateSurvivor } from "../duplicates/resolveDuplicate";
import { buildDuplicateKey } from "../duplicates/normalizeUrl";
import { resolveDuplicatePolicy } from "../duplicates/policy";
import {
  isTabInSharedGroup,
  matchesPersistentDefinition,
  persistentTabsForGroup
} from "../persistence/requirements";
import { resolveHomeWindow } from "../persistence/windowOwnership";
import type { RestoreContext } from "../persistence/startupRestore";
import type {
  ActionId,
  BrowserInventory,
  DuplicatePolicy,
  RuntimeSession,
  Snapshot,
  TabSnapshot,
  TabSnapshotRecord,
  UUID
} from "../domain/types";
import type { PlannedAction, TabRef } from "../actions/types";

export type RestorePlanResult =
  | { ok: true; actions: PlannedAction[]; reusedTabIds: number[] }
  | {
      ok: false;
      code: "SNAPSHOT_GROUP_MISSING";
      missingGroups: Array<{ id: UUID; name: string }>;
    };

function actionId(): ActionId {
  return createUuid() as unknown as ActionId;
}

function tabRef(tabId: number): TabRef {
  return { kind: "live", tabId };
}

function outputRef(actionIdValue: ActionId): TabRef {
  return { kind: "actionOutput", actionId: actionIdValue };
}

function tabMatchesSnapshotMember(
  tab: TabSnapshot,
  member: TabSnapshotRecord,
  policy: DuplicatePolicy,
  inventory: BrowserInventory,
  configuration: RestoreContext["configuration"]
): boolean {
  if (tab.incognito || tab.routing.kind !== "routable") return false;
  if (isTabInSharedGroup(tab, inventory)) return false;
  const liveKey = buildDuplicateKey(
    tab,
    policy,
    configuration.duplicateSettings
  );
  if (member.duplicateKey && liveKey && liveKey === member.duplicateKey)
    return true;
  return tab.routing.url === member.url;
}

function findReusableTab(
  member: TabSnapshotRecord,
  policy: DuplicatePolicy,
  inventory: BrowserInventory,
  context: RestoreContext & { session: RuntimeSession },
  destinationManagedGroupId: UUID,
  claimed: ReadonlySet<number>
): TabSnapshot | undefined {
  const candidates = inventory.tabs.filter(
    (tab) =>
      !claimed.has(tab.id) &&
      tabMatchesSnapshotMember(
        tab,
        member,
        policy,
        inventory,
        context.configuration
      )
  );
  if (candidates.length === 0) return undefined;
  return selectDuplicateSurvivor(
    candidates,
    destinationManagedGroupId,
    context.associations,
    context.session
  );
}

function currentPersistentRefs(
  managedGroupId: UUID,
  windowId: number,
  inventory: BrowserInventory,
  context: RestoreContext
): TabRef[] {
  const seen = new Set<number>();
  const refs: TabRef[] = [];
  for (const definition of persistentTabsForGroup(
    context.configuration,
    managedGroupId
  )) {
    const match = [...inventory.tabs]
      .filter(
        (tab) =>
          tab.windowId === windowId &&
          !tab.incognito &&
          !isTabInSharedGroup(tab, inventory) &&
          !seen.has(tab.id) &&
          matchesPersistentDefinition(tab, definition)
      )
      .sort((left, right) => left.index - right.index)[0];
    if (!match) continue;
    seen.add(match.id);
    refs.push(tabRef(match.id));
  }
  return refs;
}

function persistentFirstRefs(
  persistentRefs: readonly TabRef[],
  snapshotRefs: readonly TabRef[]
): TabRef[] {
  const liveIds = new Set(
    persistentRefs.flatMap((ref) => (ref.kind === "live" ? [ref.tabId] : []))
  );
  return [
    ...persistentRefs,
    ...snapshotRefs.filter(
      (ref) => ref.kind !== "live" || !liveIds.has(ref.tabId)
    )
  ];
}

export function planSnapshotRestore(
  snapshot: Snapshot,
  inventory: BrowserInventory,
  context: RestoreContext & { session: RuntimeSession }
): RestorePlanResult {
  const missingGroups: Array<{ id: UUID; name: string }> = [];
  for (const group of snapshot.groups) {
    const managed = context.configuration.groups.find(
      (candidate) => candidate.id === group.managedGroupId
    );
    if (!managed) {
      missingGroups.push({ id: group.managedGroupId, name: group.name });
    }
  }
  if (missingGroups.length > 0) {
    return { ok: false, code: "SNAPSHOT_GROUP_MISSING", missingGroups };
  }

  const claimed = new Set<number>();
  const reusedTabIds: number[] = [];
  const actions: PlannedAction[] = [];
  const sortedGroups = [...snapshot.groups].sort(
    (left, right) => left.order - right.order
  );

  for (const group of sortedGroups) {
    const memberTabs = [...group.tabs].sort(
      (left, right) => left.order - right.order
    );
    if (memberTabs.length === 0) continue;

    const managed = context.configuration.groups.find(
      (candidate) => candidate.id === group.managedGroupId
    )!;
    const policyForMember = (member: TabSnapshotRecord): DuplicatePolicy =>
      member.duplicatePolicy ??
      resolveDuplicatePolicy(
        null,
        managed,
        context.configuration.duplicateSettings,
        true,
        member.url
      );

    const acceptableMemberTabIds = inventory.tabs
      .filter(
        (tab) =>
          !claimed.has(tab.id) &&
          memberTabs.some((member) =>
            tabMatchesSnapshotMember(
              tab,
              member,
              policyForMember(member),
              inventory,
              context.configuration
            )
          )
      )
      .map((tab) => tab.id);
    const windowId = resolveHomeWindow(
      group.ownership ?? context.ownership[group.managedGroupId],
      inventory,
      acceptableMemberTabIds,
      context.lastFocusedWindowId
    );
    if (windowId === null) continue;

    const tabRefs: TabRef[] = [];
    const preAssignDependencies: ActionId[] = [];
    for (const member of memberTabs) {
      const policy = policyForMember(member);
      const reusable = findReusableTab(
        member,
        policy,
        inventory,
        context,
        group.managedGroupId,
        claimed
      );
      if (reusable) {
        claimed.add(reusable.id);
        reusedTabIds.push(reusable.id);
        const ref = tabRef(reusable.id);
        if (reusable.windowId !== windowId) {
          const moveId = actionId();
          actions.push({
            id: moveId,
            dependsOn: [],
            kind: "moveTabs",
            tabs: [ref],
            windowId,
            index: -1
          });
          preAssignDependencies.push(moveId);
        }
        tabRefs.push(ref);
        continue;
      }

      const createId = actionId();
      actions.push({
        id: createId,
        dependsOn: [],
        kind: "createTab",
        input: { url: member.url, windowId, active: false }
      });
      tabRefs.push(outputRef(createId));
    }

    if (tabRefs.length === 0) continue;

    const assignId = actionId();
    const assignDependsOn = [
      ...preAssignDependencies,
      ...tabRefs
        .filter(
          (ref): ref is { kind: "actionOutput"; actionId: ActionId } =>
            ref.kind === "actionOutput"
        )
        .map((ref) => ref.actionId)
    ];
    actions.push({
      id: assignId,
      dependsOn: assignDependsOn,
      kind: "assignTabsToManagedGroup",
      tabs: tabRefs as [TabRef, ...TabRef[]],
      managedGroupId: group.managedGroupId,
      windowId,
      title: renderGroupTitle({ name: group.name, emoji: group.emoji }),
      color: group.color,
      collapsed: group.collapsed
    });

    const updateId = actionId();
    actions.push({
      id: updateId,
      dependsOn: [assignId],
      kind: "updateManagedGroup",
      managedGroupId: group.managedGroupId,
      windowId,
      patch: {
        title: renderGroupTitle({ name: group.name, emoji: group.emoji }),
        color: group.color,
        collapsed: group.collapsed
      }
    });

    const moveGroupId = actionId();
    actions.push({
      id: moveGroupId,
      dependsOn: [updateId],
      kind: "moveManagedGroup",
      managedGroupId: group.managedGroupId,
      windowId,
      index: group.order
    });

    const reorderRefs = persistentFirstRefs(
      currentPersistentRefs(group.managedGroupId, windowId, inventory, context),
      tabRefs
    );
    const reorderId = actionId();
    actions.push({
      id: reorderId,
      dependsOn: [moveGroupId],
      kind: "reorderTabs",
      tabs: reorderRefs as [TabRef, ...TabRef[]],
      windowId,
      index: 0
    });
  }

  return { ok: true, actions, reusedTabIds };
}
