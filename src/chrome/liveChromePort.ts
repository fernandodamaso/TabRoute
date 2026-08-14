import type {
  ChromeGroupColor,
  ChromeInventory,
  ChromeTabSnapshot,
  RecentlyClosedTab,
  WindowSnapshot
} from "../domain/types";
import type { CreateTabInput, GroupTabsInput, LiveChromePort } from "./types";

function toTabSnapshot(tab: chrome.tabs.Tab): ChromeTabSnapshot | undefined {
  if (tab.id === undefined || tab.windowId === undefined || tab.incognito)
    return undefined;
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
    lastAccessed: tab.lastAccessed ?? 0,
    openerTabId: tab.openerTabId,
    openerUrl: undefined
  };
}

async function readInventoryFromChrome(): Promise<ChromeInventory> {
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal"]
  });
  const normalWindows: WindowSnapshot[] = windows
    .filter(
      (window): window is chrome.windows.Window & { id: number } =>
        window.id !== undefined && window.type === "normal" && !window.incognito
    )
    .map((window) => ({
      id: window.id,
      focused: window.focused ?? false,
      incognito: false,
      type: "normal"
    }));
  const rawTabs = windows.flatMap((window) => window.tabs ?? []);
  const urlsById = new Map(
    rawTabs.flatMap((tab) =>
      tab.id === undefined || !tab.url ? [] : [[tab.id, tab.url] as const]
    )
  );
  const tabs = rawTabs
    .map(toTabSnapshot)
    .filter((tab): tab is ChromeTabSnapshot => tab !== undefined)
    .map((tab) => ({
      ...tab,
      openerUrl:
        tab.openerTabId === undefined
          ? undefined
          : urlsById.get(tab.openerTabId)
    }));
  const normalWindowIds = new Set(normalWindows.map((window) => window.id));
  const groups = (await chrome.tabGroups.query({})).flatMap((group) => {
    if (
      group.id === undefined ||
      group.windowId === undefined ||
      !normalWindowIds.has(group.windowId)
    )
      return [];
    const shared =
      (group as chrome.tabGroups.TabGroup & { shared?: boolean }).shared ??
      false;
    return [
      {
        id: group.id,
        windowId: group.windowId,
        title: group.title ?? "",
        color: (group.color ?? "grey") as ChromeGroupColor,
        collapsed: group.collapsed ?? false,
        shared
      }
    ];
  });
  return { windows: normalWindows, tabs, groups, capturedAt: Date.now() };
}

export function createLiveChromePort(): LiveChromePort {
  return {
    readInventory: readInventoryFromChrome,
    async getLastFocusedNormalWindowId() {
      const windows = await chrome.windows.getAll({
        windowTypes: ["normal"]
      });
      const focused = windows.find(
        (window) =>
          window.focused &&
          window.id !== undefined &&
          !window.incognito &&
          window.type === "normal"
      );
      return focused?.id ?? null;
    },
    async getRecentlyClosed(maxResults) {
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults });
      const entries: RecentlyClosedTab[] = [];
      for (const session of sessions) {
        const tab = session.tab;
        if (!tab?.sessionId) continue;
        entries.push({
          sessionId: tab.sessionId,
          url: tab.url,
          title: tab.title ?? "",
          lastAccessed: tab.lastAccessed ?? 0
        });
      }
      return entries;
    },
    async groupTabs(input: GroupTabsInput) {
      if (input.kind === "existing")
        return chrome.tabs.group({
          tabIds: [...input.tabIds],
          groupId: input.chromeGroupId
        });
      return chrome.tabs.group({
        tabIds: [...input.tabIds],
        createProperties: { windowId: input.windowId }
      });
    },
    async ungroupTabs(tabIds) {
      const ids = [...tabIds] as [number, ...number[]];
      await chrome.tabs.ungroup(ids);
    },
    async moveTabs(tabIds, windowId, index) {
      await chrome.tabs.move([...tabIds], { windowId, index });
    },
    async updateGroup(groupId, patch) {
      await chrome.tabGroups.update(groupId, patch);
    },
    async createTab(input: CreateTabInput) {
      const window = await chrome.windows.get(input.windowId);
      if (window.incognito) {
        throw new Error("createTab refuses an incognito windowId");
      }
      const created = await chrome.tabs.create({
        url: input.url,
        windowId: input.windowId,
        active: input.active ?? false,
        ...(input.index === undefined ? {} : { index: input.index })
      });
      if (created.id === undefined) throw new Error("createTab returned no id");
      return created.id;
    },
    async removeTabs(tabIds) {
      await chrome.tabs.remove([...tabIds]);
    },
    async moveGroup(groupId, windowId, index) {
      await chrome.tabGroups.move(groupId, { windowId, index });
    },
    async focusTab(tabId, windowId) {
      await chrome.windows.update(windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
    },
    async restoreClosedTab(sessionId) {
      if (!sessionId) throw new Error("restoreClosedTab requires sessionId");
      const restored = await chrome.sessions.restore(sessionId);
      const tabId = restored.tab?.id;
      if (tabId === undefined)
        throw new Error("restoreClosedTab returned no tab");
      return tabId;
    }
  };
}
