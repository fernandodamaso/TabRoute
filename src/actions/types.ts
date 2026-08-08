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
export type ActionPlan = RouteToGroupPlan | UngroupPlan;

export type ActionResult =
  | {
      kind: "held";
      reason: "not-routable" | "incognito" | "unmanaged-placement" | "paused";
    }
  | { kind: "noop"; reason: "already-in-target" | "already-ungrouped" }
  | {
      kind: "executed";
      chromeGroupId: number;
      inventory: import("../domain/types").ChromeInventory;
    };
