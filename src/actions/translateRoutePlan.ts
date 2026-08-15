import { createUuid } from "../domain/ids";
import type { ActionId } from "../domain/types";
import type { ActionPlan, PlannedAction, RoutePlan } from "./types";
import { buildActionPlan } from "./buildActionPlan";

export function translateRoutePlan(route: RoutePlan): ActionPlan {
  const actionId = createUuid() as unknown as ActionId;
  if (route.kind === "ungroup") {
    const action: PlannedAction = {
      id: actionId,
      dependsOn: [],
      kind: "ungroupTabs",
      tabs: [{ kind: "live", tabId: route.tab.id }]
    };
    return buildActionPlan("reconcile", [action]);
  }
  const action: PlannedAction = {
    id: actionId,
    dependsOn: [],
    kind: "assignTabsToManagedGroup",
    tabs: [{ kind: "live", tabId: route.tab.id }],
    managedGroupId: route.managedGroupId,
    windowId: route.tab.windowId,
    title: route.title,
    color: route.color,
    ...(route.collapsed === undefined ? {} : { collapsed: route.collapsed })
  };
  return buildActionPlan("reconcile", [action]);
}
