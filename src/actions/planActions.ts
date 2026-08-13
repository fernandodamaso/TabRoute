import type {
  ChromeAssociation,
  ChromeInventory,
  Configuration,
  ChromeTabSnapshot,
  UUID
} from "../domain/types";
import type { RoutePlan } from "./types";
import { renderGroupTitle } from "../groups/displayTitle";
import { isRoutableUrl } from "../chrome/types";
import { placementAction, selectRule } from "../rules/ruleEngine";

export function planFallbackRoute(input: {
  inventory: ChromeInventory;
  tab: ChromeTabSnapshot;
  configuration: Configuration;
  associations: readonly ChromeAssociation[];
}):
  | RoutePlan
  | {
      kind: "held";
      reason: "not-routable" | "incognito" | "unmanaged-placement";
    }
  | { kind: "noop"; reason: "already-in-target" } {
  const { inventory, tab, configuration, associations } = input;
  if (tab.incognito) return { kind: "held", reason: "incognito" };
  if (!isRoutableUrl(tab.url)) return { kind: "held", reason: "not-routable" };
  const currentGroup = inventory.groups.find(
    (group) => group.id === tab.chromeGroupId
  );
  const targetAssociation = associations.find(
    (association) =>
      association.managedGroupId === configuration.fallbackGroupId &&
      association.chromeWindowId === tab.windowId
  );
  if (currentGroup?.shared)
    return { kind: "held", reason: "unmanaged-placement" };
  if (targetAssociation?.chromeGroupId === tab.chromeGroupId)
    return { kind: "noop", reason: "already-in-target" };
  const fallback = configuration.groups.find(
    (group) => group.id === configuration.fallbackGroupId
  );
  if (!fallback) throw new Error("fallback group is missing");
  const existing =
    targetAssociation &&
    inventory.groups.find(
      (group) =>
        group.id === targetAssociation.chromeGroupId &&
        group.windowId === tab.windowId &&
        !group.shared
    );
  return {
    kind: "routeToFallback",
    tab,
    managedGroupId: fallback.id,
    groupInput: existing
      ? {
          kind: "existing",
          tabIds: [tab.id],
          chromeGroupId: existing.id,
          windowId: tab.windowId
        }
      : { kind: "create", tabIds: [tab.id], windowId: tab.windowId },
    title: renderGroupTitle(fallback),
    color: fallback.color
  };
}

export function planRuleRoute(input: {
  inventory: ChromeInventory;
  tab: ChromeTabSnapshot;
  configuration: Configuration;
  associations: readonly ChromeAssociation[];
  intentionallyClosedGroupIds?: readonly UUID[];
}):
  | RoutePlan
  | {
      kind: "held";
      reason: "not-routable" | "incognito" | "unmanaged-placement" | "paused";
    }
  | { kind: "noop"; reason: "already-in-target" | "already-ungrouped" } {
  const selected = selectRule(input);
  if (!selected) return planFallbackRoute(input);
  if (
    input.intentionallyClosedGroupIds?.includes(selected.rule.targetGroupId)
  ) {
    return planFallbackRoute(input);
  }
  const placement = placementAction(selected.rule.actions);
  if (placement === "ungroup") {
    if (input.tab.chromeGroupId < 0)
      return { kind: "noop", reason: "already-ungrouped" };
    const group = input.inventory.groups.find(
      (candidate) => candidate.id === input.tab.chromeGroupId
    );
    if (group?.shared) return { kind: "held", reason: "unmanaged-placement" };
    return { kind: "ungroup", tab: input.tab };
  }
  return planManagedGroupRoute({
    ...input,
    targetGroupId: selected.rule.targetGroupId,
    collapsed: selected.rule.actions.find(
      (action) => action.kind === "setCollapsed"
    )?.collapsed
  });
}

export function planManagedGroupRoute(input: {
  inventory: ChromeInventory;
  tab: ChromeTabSnapshot;
  configuration: Configuration;
  associations: readonly ChromeAssociation[];
  targetGroupId: UUID;
  collapsed?: boolean;
}):
  | RoutePlan
  | {
      kind: "held";
      reason: "not-routable" | "incognito" | "unmanaged-placement" | "paused";
    }
  | { kind: "noop"; reason: "already-in-target" | "already-ungrouped" } {
  const { inventory, tab, configuration, associations } = input;
  if (tab.incognito) return { kind: "held", reason: "incognito" };
  if (!isRoutableUrl(tab.url)) return { kind: "held", reason: "not-routable" };
  const currentGroup = inventory.groups.find(
    (group) => group.id === tab.chromeGroupId
  );
  if (currentGroup?.shared)
    return { kind: "held", reason: "unmanaged-placement" };
  const target = configuration.groups.find(
    (group) => group.id === input.targetGroupId
  );
  if (!target) throw new Error("rule target group is missing");
  const targetAssociation = associations.find(
    (association) =>
      association.managedGroupId === target.id &&
      association.chromeWindowId === tab.windowId
  );
  if (targetAssociation?.chromeGroupId === tab.chromeGroupId)
    return { kind: "noop", reason: "already-in-target" };
  const existing =
    targetAssociation &&
    inventory.groups.find(
      (group) =>
        group.id === targetAssociation.chromeGroupId &&
        group.windowId === tab.windowId &&
        !group.shared
    );
  return {
    kind: "routeToGroup",
    tab,
    managedGroupId: target.id,
    groupInput: existing
      ? {
          kind: "existing",
          tabIds: [tab.id],
          chromeGroupId: existing.id,
          windowId: tab.windowId
        }
      : { kind: "create", tabIds: [tab.id], windowId: tab.windowId },
    title: renderGroupTitle(target),
    color: target.color,
    collapsed: input.collapsed
  };
}
