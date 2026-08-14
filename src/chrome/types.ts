import type {
  ChromeGroupColor,
  ChromeInventory,
  ChromeTabSnapshot,
  RecentlyClosedTab
} from "../domain/types";

export type {
  ChromeInventory,
  ChromeTabSnapshot,
  RecentlyClosedTab
} from "../domain/types";

export type GroupTabsInput =
  | { kind: "create"; tabIds: readonly [number, ...number[]]; windowId: number }
  | {
      kind: "existing";
      tabIds: readonly [number, ...number[]];
      chromeGroupId: number;
      windowId: number;
    };

export interface CreateTabInput {
  url: string;
  windowId: number;
  active?: false;
  index?: number;
}

export interface ChromeReadPort {
  readInventory(): Promise<ChromeInventory>;
  getLastFocusedNormalWindowId(): Promise<number | null>;
  getRecentlyClosed(maxResults: number): Promise<readonly RecentlyClosedTab[]>;
}

export interface ChromeMutationPort {
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
  createTab(input: CreateTabInput): Promise<number>;
  removeTabs(tabIds: readonly number[]): Promise<void>;
  moveGroup(groupId: number, windowId: number, index: number): Promise<void>;
  focusTab(tabId: number, windowId: number): Promise<void>;
  restoreClosedTab(sessionId: string): Promise<number>;
}

export type LiveChromePort = ChromeReadPort & ChromeMutationPort;

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
