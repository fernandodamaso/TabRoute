import type { ChromeTabSnapshot } from "../domain/types";
import type { GroupTabsInput } from "../chrome/types";

export interface RouteToFallbackPlan {
  kind: "routeToFallback";
  tab: ChromeTabSnapshot;
  groupInput: GroupTabsInput;
  title: string;
  color: "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";
}

export type ActionPlan = RouteToFallbackPlan;

export type ActionResult =
  | { kind: "held"; reason: "not-routable" | "incognito" | "unmanaged-placement" }
  | { kind: "noop"; reason: "already-in-target" }
  | { kind: "executed"; chromeGroupId: number; inventory: import("../domain/types").ChromeInventory };
