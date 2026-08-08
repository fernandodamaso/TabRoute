import type { ChromeMutationPort } from "../chrome/types";
import { findTab, isRoutableUrl } from "../chrome/types";
import type { ActionPlan, ActionResult } from "./types";

export async function executeActionPlan(
  plan: ActionPlan,
  chrome: ChromeMutationPort
): Promise<ActionResult> {
  const fresh = await chrome.readInventory();
  const tab = findTab(fresh, plan.tab.id);
  if (!tab || tab.incognito) return { kind: "held", reason: "incognito" };
  if (!isRoutableUrl(tab.url)) return { kind: "held", reason: "not-routable" };
  if (plan.kind === "ungroup") {
    if (tab.chromeGroupId < 0)
      return { kind: "noop", reason: "already-ungrouped" };
    await chrome.ungroupTabs([tab.id]);
    const verified = await chrome.readInventory();
    const verifiedTab = findTab(verified, tab.id);
    if (!verifiedTab || verifiedTab.chromeGroupId >= 0)
      throw new Error("Action Engine ungroup postcondition failed");
    return { kind: "executed", chromeGroupId: -1, inventory: verified };
  }
  const chromeGroupId = await chrome.groupTabs(plan.groupInput);
  await chrome.updateGroup(chromeGroupId, {
    title: plan.title,
    color: plan.color,
    ...(plan.collapsed === undefined ? {} : { collapsed: plan.collapsed })
  });
  const verified = await chrome.readInventory();
  const verifiedTab = findTab(verified, tab.id);
  if (!verifiedTab || verifiedTab.chromeGroupId !== chromeGroupId)
    throw new Error("Action Engine postcondition failed");
  return { kind: "executed", chromeGroupId, inventory: verified };
}
