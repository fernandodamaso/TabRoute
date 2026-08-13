import { WINDOW_ID_NONE } from "../activity/undoPlanner";
import type {
  ChromeAssociation,
  ChromeInventory,
  ChromeTabSnapshot,
  ManagedGroup,
  WindowOwnershipDescriptor
} from "../domain/types";
import type { UUID } from "../domain/types";

export function resolveHomeWindow(
  descriptor: WindowOwnershipDescriptor | undefined,
  inventory: ChromeInventory,
  acceptableMemberTabIds: readonly number[],
  lastFocusedWindowId: number | null
): number | null {
  const normalWindows = inventory.windows.filter(
    (window) => window.type === "normal" && !window.incognito
  );
  if (normalWindows.length === 0) return null;

  const memberWindows = new Set(
    inventory.tabs
      .filter((tab) => acceptableMemberTabIds.includes(tab.id))
      .map((tab) => tab.windowId)
  );
  if (memberWindows.size === 1) {
    const windowId = memberWindows.values().next().value!;
    if (
      windowId !== WINDOW_ID_NONE &&
      normalWindows.some((window) => window.id === windowId)
    ) {
      return windowId;
    }
  }

  if (descriptor && descriptor.memberUrls.length > 0) {
    const matching = normalWindows.filter((window) => {
      const urls = inventory.tabs
        .filter((tab) => tab.windowId === window.id)
        .map((tab) => tab.url ?? "");
      return descriptor.memberUrls.some((url) => urls.includes(url));
    });
    if (matching.length === 1) return matching[0]!.id;
  }

  if (
    lastFocusedWindowId !== null &&
    lastFocusedWindowId !== WINDOW_ID_NONE &&
    normalWindows.some((window) => window.id === lastFocusedWindowId)
  ) {
    return lastFocusedWindowId;
  }

  const focused = normalWindows.find((window) => window.focused);
  return focused?.id ?? normalWindows[0]!.id;
}

export function captureOwnershipDescriptor(
  managedGroupId: UUID,
  group: ManagedGroup,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): WindowOwnershipDescriptor | undefined {
  const association = associations.find(
    (candidate) => candidate.managedGroupId === managedGroupId
  );
  if (!association) return undefined;
  const memberUrls = inventory.tabs
    .filter((tab) => tab.chromeGroupId === association.chromeGroupId)
    .map((tab) => tab.url ?? "")
    .filter((url) => url.length > 0);
  return {
    memberUrls,
    order: group.defaultOrder,
    collapsed: group.defaultCollapsed
  };
}

export function ownershipFromDescriptor(
  descriptor: WindowOwnershipDescriptor | undefined
): WindowOwnershipDescriptor | undefined {
  if (!descriptor) return undefined;
  if (
    typeof descriptor.order === "number" &&
    typeof descriptor.collapsed === "boolean" &&
    Array.isArray(descriptor.memberUrls)
  ) {
    return descriptor;
  }
  return undefined;
}

export function collectWindowManagedGroupIds(
  windowId: number,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): UUID[] {
  const groupIds = inventory.tabs
    .filter((tab) => tab.windowId === windowId && tab.chromeGroupId >= 0)
    .map((tab) => tab.chromeGroupId);
  const managed = new Set<UUID>();
  for (const chromeGroupId of groupIds) {
    const group = inventory.groups.find((candidate) => candidate.id === chromeGroupId);
    if (!group || group.shared) continue;
    const association = associations.find(
      (candidate) =>
        candidate.chromeGroupId === chromeGroupId &&
        candidate.chromeWindowId === windowId
    );
    if (association) managed.add(association.managedGroupId);
  }
  return [...managed];
}

export function persistentManagedGroupsInWindow(
  windowId: number,
  configuration: import("../domain/types").Configuration,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): UUID[] {
  return collectWindowManagedGroupIds(windowId, inventory, associations).filter(
    (managedGroupId) => {
      const group = configuration.groups.find(
        (candidate) => candidate.id === managedGroupId
      );
      return group?.isPersistent === true;
    }
  );
}

export function tabSnapshotFromChrome(tab: ChromeTabSnapshot): import("../domain/types").TabSnapshot {
  const url = tab.url;
  return {
    ...tab,
    routing:
      url && (url.startsWith("http://") || url.startsWith("https://"))
        ? { kind: "routable", url }
        : { kind: "pending" }
  };
}
