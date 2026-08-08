import type { ChromeAssociation, ChromeInventory, Configuration, ChromeTabSnapshot } from "../domain/types";
import type { ActionPlan } from "./types";
import { renderGroupTitle } from "../groups/displayTitle";
import { isRoutableUrl } from "../chrome/types";

export function planFallbackRoute(input: {
  inventory: ChromeInventory;
  tab: ChromeTabSnapshot;
  configuration: Configuration;
  associations: readonly ChromeAssociation[];
}): ActionPlan | { kind: "held"; reason: "not-routable" | "incognito" | "unmanaged-placement" } | { kind: "noop"; reason: "already-in-target" } {
  const { inventory, tab, configuration, associations } = input;
  if (tab.incognito) return { kind: "held", reason: "incognito" };
  if (!isRoutableUrl(tab.url)) return { kind: "held", reason: "not-routable" };
  const currentGroup = inventory.groups.find((group) => group.id === tab.chromeGroupId);
  const targetAssociation = associations.find((association) => association.managedGroupId === configuration.fallbackGroupId && association.chromeWindowId === tab.windowId);
  if (currentGroup?.shared || (tab.chromeGroupId >= 0 && targetAssociation?.chromeGroupId !== tab.chromeGroupId)) {
    if (currentGroup && !currentGroup.shared) return { kind: "held", reason: "unmanaged-placement" };
    if (currentGroup?.shared) return { kind: "held", reason: "unmanaged-placement" };
  }
  if (targetAssociation?.chromeGroupId === tab.chromeGroupId) return { kind: "noop", reason: "already-in-target" };
  const fallback = configuration.groups.find((group) => group.id === configuration.fallbackGroupId);
  if (!fallback) throw new Error("fallback group is missing");
  const existing = targetAssociation && inventory.groups.find((group) => group.id === targetAssociation.chromeGroupId && group.windowId === tab.windowId && !group.shared);
  return {
    kind: "routeToFallback",
    tab,
    groupInput: existing
      ? { kind: "existing", tabIds: [tab.id], chromeGroupId: existing.id, windowId: tab.windowId }
      : { kind: "create", tabIds: [tab.id], windowId: tab.windowId },
    title: renderGroupTitle(fallback),
    color: fallback.color
  };
}
