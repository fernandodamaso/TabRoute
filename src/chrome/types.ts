import type {
  ChromeGroupColor,
  ChromeInventory,
  ChromeTabSnapshot
} from "../domain/types";

export type { ChromeInventory, ChromeTabSnapshot } from "../domain/types";

export type GroupTabsInput =
  | { kind: "create"; tabIds: readonly [number, ...number[]]; windowId: number }
  | {
      kind: "existing";
      tabIds: readonly [number, ...number[]];
      chromeGroupId: number;
      windowId: number;
    };

export interface ChromeMutationPort {
  readInventory(): Promise<ChromeInventory>;
  groupTabs(input: GroupTabsInput): Promise<number>;
  ungroupTabs(tabIds: readonly number[]): Promise<void>;
  moveTabs(
    tabIds: readonly number[],
    windowId: number,
    index: number
  ): Promise<void>;
  updateGroup(
    groupId: number,
    patch: { title?: string; color?: ChromeGroupColor; collapsed?: boolean }
  ): Promise<void>;
}

export function isRoutableUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function findTab(
  inventory: ChromeInventory,
  tabId: number
): ChromeTabSnapshot | undefined {
  return inventory.tabs.find((tab) => tab.id === tabId);
}
