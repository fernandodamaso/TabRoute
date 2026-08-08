import type { ChromeMutationPort } from "../chrome/types";
import { findTab, isRoutableUrl } from "../chrome/types";
import type { ActionPlan, ActionResult } from "./types";

export async function executeActionPlan(plan: ActionPlan, chrome: ChromeMutationPort): Promise<ActionResult> {
  const fresh = await chrome.readInventory();
  const tab = findTab(fresh, plan.tab.id);
  if (!tab || tab.incognito) return { kind: "held", reason: "incognito" };
  if (!isRoutableUrl(tab.url)) return { kind: "held", reason: "not-routable" };
  const chromeGroupId = await chrome.groupTabs(plan.groupInput);
  await chrome.updateGroup(chromeGroupId, { title: plan.title, color: plan.color });
  const verified = await chrome.readInventory();
  const verifiedTab = findTab(verified, tab.id);
  if (!verifiedTab || verifiedTab.chromeGroupId !== chromeGroupId) throw new Error("Action Engine postcondition failed");
  return { kind: "executed", chromeGroupId, inventory: verified };
}
