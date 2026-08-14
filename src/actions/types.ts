import type { ChromeTabSnapshot } from "../domain/types";
import type { GroupTabsInput } from "../chrome/types";

export interface RouteToGroupPlan {
  kind: "routeToGroup" | "routeToFallback";
  tab: ChromeTabSnapshot;
  groupInput: GroupTabsInput;
  managedGroupId: import("../domain/types").UUID;
  title: string;
  color:
    | "grey"
    | "blue"
    | "red"
    | "yellow"
    | "green"
    | "pink"
    | "purple"
    | "cyan"
    | "orange";
  collapsed?: boolean;
}

export interface UngroupPlan {
  kind: "ungroup";
  tab: ChromeTabSnapshot;
}

export type RouteToFallbackPlan = RouteToGroupPlan;
export type RoutePlan = RouteToGroupPlan | UngroupPlan;

export type RouteResult =
  | {
      kind: "held";
      reason:
        | "not-routable"
        | "incognito"
        | "unmanaged-placement"
        | "manual-override"
        | "paused";
    }
  | { kind: "noop"; reason: "already-in-target" | "already-ungrouped" }
  | {
      kind: "executed";
      chromeGroupId: number;
      inventory: import("../domain/types").ChromeInventory;
    };

export type TabRef =
  | { kind: "live"; tabId: number }
  | { kind: "actionOutput"; actionId: import("../domain/types").ActionId };

export interface ActionBase {
  id: import("../domain/types").ActionId;
  dependsOn: import("../domain/types").ActionId[];
}

export type PlannedAction =
  | (ActionBase & {
      kind: "createTab";
      input: { url: string; windowId: number; active?: false; index?: number };
    })
  | (ActionBase & {
      kind: "restoreClosedTab";
      sessionId: string;
      expectedUrl?: string;
      windowId?: number;
    })
  | (ActionBase & {
      kind: "moveTabs";
      tabs: readonly [TabRef, ...TabRef[]];
      windowId: number;
      index: number;
    })
  | (ActionBase & {
      kind: "assignTabsToManagedGroup";
      tabs: readonly [TabRef, ...TabRef[]];
      managedGroupId: import("../domain/types").UUID;
      windowId: number;
      title: string;
      color: RouteToGroupPlan["color"];
      collapsed?: boolean;
    })
  | (ActionBase & {
      kind: "assignTabsToUnmanagedGroup";
      tabs: readonly [TabRef, ...TabRef[]];
      chromeGroupId: number;
      windowId: number;
    })
  | (ActionBase & {
      kind: "ungroupTabs";
      tabs: readonly [TabRef, ...TabRef[]];
    })
  | (ActionBase & {
      kind: "updateManagedGroup";
      managedGroupId: import("../domain/types").UUID;
      patch: {
        title?: string;
        color?: RouteToGroupPlan["color"];
        collapsed?: boolean;
      };
    })
  | (ActionBase & {
      kind: "moveManagedGroup";
      managedGroupId: import("../domain/types").UUID;
      windowId: number;
      index: number;
    })
  | (ActionBase & {
      kind: "reorderTabs";
      tabs: readonly [TabRef, ...TabRef[]];
      windowId: number;
      index: number;
    })
  | (ActionBase & {
      kind: "focusTab";
      tab: TabRef;
      windowId: number;
    })
  | (ActionBase & {
      kind: "closeDuplicate";
      duplicate: TabRef;
      survivor: TabRef;
    });

export type ActionPlanSource =
  "reconcile" | "user" | "undo" | "snapshot" | "startup" | "duplicate";

export interface ActionPlan {
  id: import("../domain/types").ActionId;
  source: ActionPlanSource;
  actions: PlannedAction[];
  checkpoint: "required" | "none";
}

export interface EngineActionResult {
  actionId: import("../domain/types").ActionId;
  status: "success" | "degraded" | "failure";
  completed: import("../domain/types").ActionId[];
  outputs: Record<
    import("../domain/types").ActionId,
    ChromeTabSnapshot | { chromeGroupId: number }
  >;
  errorCode?: string;
}
