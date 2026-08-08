import type { ChromeGroupColor, ChromeInventory, ChromeTabSnapshot, WindowSnapshot } from "../domain/types";
import type { ChromeMutationPort, GroupTabsInput } from "./types";

function toTabSnapshot(tab: chrome.tabs.Tab): ChromeTabSnapshot | undefined {
  if (tab.id === undefined || tab.windowId === undefined || tab.incognito) return undefined;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    chromeGroupId: tab.groupId ?? -1,
    url: tab.url,
    pendingUrl: tab.pendingUrl,
    status: tab.status,
    title: tab.title ?? "",
    pinned: tab.pinned ?? false,
    active: tab.active ?? false,
    incognito: false,
    lastAccessed: tab.lastAccessed ?? 0
  };
}

export function createLiveChromePort(): ChromeMutationPort {
  return {
    async readInventory(): Promise<ChromeInventory> {
      const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
      const normalWindows: WindowSnapshot[] = windows
        .filter((window): window is chrome.windows.Window & { id: number } => window.id !== undefined && window.type === "normal" && !window.incognito)
        .map((window) => ({ id: window.id, focused: window.focused ?? false, incognito: false, type: "normal" }));
      const tabs = windows.flatMap((window) => (window.tabs ?? []).map(toTabSnapshot).filter((tab): tab is ChromeTabSnapshot => tab !== undefined));
      const normalWindowIds = new Set(normalWindows.map((window) => window.id));
      const groups = (await chrome.tabGroups.query({})).flatMap((group) => {
        if (group.id === undefined || group.windowId === undefined || !normalWindowIds.has(group.windowId)) return [];
        const shared = (group as chrome.tabGroups.TabGroup & { shared?: boolean }).shared ?? false;
        return [{ id: group.id, windowId: group.windowId, title: group.title ?? "", color: (group.color ?? "grey") as ChromeGroupColor, collapsed: group.collapsed ?? false, shared }];
      });
      return { windows: normalWindows, tabs, groups, capturedAt: Date.now() };
    },
    async groupTabs(input: GroupTabsInput) {
      if (input.kind === "existing") return chrome.tabs.group({ tabIds: [...input.tabIds], groupId: input.chromeGroupId });
      return chrome.tabs.group({ tabIds: [...input.tabIds], createProperties: { windowId: input.windowId } });
    },
    async moveTabs(tabIds, windowId, index) {
      await chrome.tabs.move([...tabIds], { windowId, index });
    },
    async updateGroup(groupId, patch) {
      await chrome.tabGroups.update(groupId, patch);
    }
  };
}
