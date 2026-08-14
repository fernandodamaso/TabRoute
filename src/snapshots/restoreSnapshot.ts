import { createUuid } from "../domain/ids";
import { renderGroupTitle } from "../groups/displayTitle";
import { selectDuplicateSurvivor } from "../duplicates/resolveDuplicate";
import { buildDuplicateKey } from "../duplicates/normalizeUrl";
import { resolveDuplicatePolicy } from "../duplicates/policy";
import { isTabInSharedGroup } from "../persistence/requirements";
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

function snapshotRecordTab(member: TabSnapshotRecord): TabSnapshot {
  return {
    id: -1,
    windowId: -1,
    index: 0,
    chromeGroupId: -1,
    url: member.url,
    status: "complete",
    title: member.title,
    pinned: false,
    active: false,
    incognito: false,
    lastAccessed: 0,
    routing: { kind: "routable", url: member.url }
  };
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
  const plannedByKey = new Map<string, TabRef>();
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
    const keyForMember = (
      member: TabSnapshotRecord,
      policy: DuplicatePolicy
    ): string | null => {
      if (policy.kind === "allow") return null;
      return (
        member.duplicateKey ??
        buildDuplicateKey(
          snapshotRecordTab(member),
          policy,
          context.configuration.duplicateSettings
        )
      );
    };

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
    for (const member of memberTabs) {
      const policy = policyForMember(member);
      const key = keyForMember(member, policy);
      const planned = key ? plannedByKey.get(key) : undefined;
      if (planned) {
        tabRefs.push(planned);
        continue;
      }

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
        tabRefs.push(ref);
        if (key) plannedByKey.set(key, ref);
        continue;
      }

      const createId = actionId();
      actions.push({
        id: createId,
        dependsOn: [],
        kind: "createTab",
        input: { url: member.url, windowId, active: false }
      });
      const ref = outputRef(createId);
      tabRefs.push(ref);
      if (key) plannedByKey.set(key, ref);
    }

    if (tabRefs.length === 0) continue;

    const assignId = actionId();
    const assignDependsOn = tabRefs
      .filter(
        (ref): ref is { kind: "actionOutput"; actionId: ActionId } =>
          ref.kind === "actionOutput"
      )
      .map((ref) => ref.actionId);
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

    const reorderId = actionId();
    actions.push({
      id: reorderId,
      dependsOn: [moveGroupId],
      kind: "reorderTabs",
      tabs: tabRefs as [TabRef, ...TabRef[]],
      windowId,
      index: 0
    });
  }

  return { ok: true, actions, reusedTabIds };
}
