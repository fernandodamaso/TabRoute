import { createUuid } from "../domain/ids";
import type {
  BrowserInventory,
  ChromeAssociation,
  Configuration,
  Snapshot,
  SnapshotGroup,
  SnapshotScope,
  TabSnapshot,
  UUID,
  WindowOwnershipDescriptor
} from "../domain/types";
import {
  isTabInSharedGroup,
  managedGroupIdForTab
} from "../persistence/requirements";

export interface SnapshotContext {
  configuration: Configuration;
  ownership: Record<UUID, WindowOwnershipDescriptor>;
  associations: readonly ChromeAssociation[];
}

function memberTabsForManagedGroup(
  managedGroupId: UUID,
  inventory: BrowserInventory,
  associations: readonly ChromeAssociation[]
): TabSnapshot[] {
  return inventory.tabs.filter((tab) => {
    if (tab.routing.kind !== "routable") return false;
    if (isTabInSharedGroup(tab, inventory)) return false;
    return managedGroupIdForTab(tab, inventory, associations) === managedGroupId;
  });
}

export function captureSnapshot(
  scope: SnapshotScope,
  inventory: BrowserInventory,
  context: SnapshotContext,
  metadata: {
    id: UUID;
    name: string;
    kind: Snapshot["kind"];
    now: number;
  }
): Snapshot {
  const groups: SnapshotGroup[] = [];
  const managedIds =
    scope.kind === "group"
      ? [scope.managedGroupId]
      : context.configuration.groups.map((group) => group.id);

  for (const managedGroupId of managedIds) {
    const managed = context.configuration.groups.find(
      (group) => group.id === managedGroupId
    );
    if (!managed) continue;
    const memberTabs = memberTabsForManagedGroup(
      managedGroupId,
      inventory,
      context.associations
    );
    groups.push({
      managedGroupId,
      name: managed.name,
      emoji: managed.emoji,
      color: managed.color,
      collapsed: managed.defaultCollapsed,
      order: managed.defaultOrder,
      ownership: context.ownership[managedGroupId],
      tabs: memberTabs.flatMap((tab, index) => {
        if (tab.routing.kind !== "routable") return [];
        return [{
          url: tab.routing.url,
          title: tab.title,
          duplicateKey: tab.routing.url,
          order: index
        }];
      })
    });
  }

  return {
    schemaVersion: 1,
    id: metadata.id,
    name: metadata.name,
    kind: metadata.kind,
    scope,
    groups,
    createdAt: metadata.now,
    updatedAt: metadata.now
  };
}

export function snapshotToCheckpointSnapshot(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot);
}

export function createCheckpointSnapshotId(): UUID {
  return createUuid();
}
