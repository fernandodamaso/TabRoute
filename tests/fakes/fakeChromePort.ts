import type {
  ChromeGroupColor,
  ChromeInventory,
  ChromeTabSnapshot
} from "../../src/domain/types";
import type {
  CreateTabInput,
  GroupTabsInput,
  LiveChromePort
} from "../../src/chrome/types";

export interface FakeChromeStorage {
  inventory: ChromeInventory;
  recentlyClosed: Array<{
    sessionId?: string;
    url?: string;
    title?: string;
    lastAccessed?: number;
  }>;
  lastFocusedWindowId: number | null;
  nextTabId: number;
  nextGroupId: number;
}

export interface FakeChromePortOptions {
  storage?: FakeChromeStorage;
  errors?: Partial<Record<keyof LiveChromePort, Error>>;
}

function defaultStorage(initial: ChromeInventory): FakeChromeStorage {
  const maxTabId = initial.tabs.reduce((max, tab) => Math.max(max, tab.id), 0);
  const maxGroupId = initial.groups.reduce(
    (max, group) => Math.max(max, group.id),
    0
  );
  return {
    inventory: structuredClone(initial),
    recentlyClosed: [],
    lastFocusedWindowId:
      initial.windows.find((window) => window.focused)?.id ?? null,
    nextTabId: maxTabId + 1,
    nextGroupId: maxGroupId + 1
  };
}

export function createFakeChromePort(
  initial: ChromeInventory,
  options: FakeChromePortOptions = {}
): LiveChromePort & {
  callsFor(method: keyof LiveChromePort): unknown[][];
  setError(method: keyof LiveChromePort, error: Error | undefined): void;
  getStorage(): FakeChromeStorage;
  getInventory(): ChromeInventory;
} {
  const storage = options.storage ?? defaultStorage(initial);
  const calls = new Map<keyof LiveChromePort, unknown[][]>();
  const errors = new Map<keyof LiveChromePort, Error>(
    Object.entries(options.errors ?? {}) as [keyof LiveChromePort, Error][]
  );

  function record(method: keyof LiveChromePort, args: unknown[]) {
    const list = calls.get(method) ?? [];
    list.push(args);
    calls.set(method, list);
  }

  function maybeThrow(method: keyof LiveChromePort) {
    const error = errors.get(method);
    if (error) throw error;
  }

  const port: LiveChromePort = {
    async readInventory() {
      record("readInventory", []);
      maybeThrow("readInventory");
      return structuredClone(storage.inventory);
    },
    async getLastFocusedNormalWindowId() {
      record("getLastFocusedNormalWindowId", []);
      maybeThrow("getLastFocusedNormalWindowId");
      return storage.lastFocusedWindowId;
    },
    async getRecentlyClosed(maxResults) {
      record("getRecentlyClosed", [maxResults]);
      maybeThrow("getRecentlyClosed");
      return storage.recentlyClosed.slice(0, maxResults).map((entry) => ({
        sessionId: entry.sessionId,
        url: entry.url,
        title: entry.title ?? "",
        lastAccessed: entry.lastAccessed ?? 0
      }));
    },
    async groupTabs(input: GroupTabsInput) {
      record("groupTabs", [input]);
      maybeThrow("groupTabs");
      const id =
        input.kind === "existing" ? input.chromeGroupId : storage.nextGroupId++;
      if (input.kind === "create") {
        storage.inventory.groups = [
          ...storage.inventory.groups.filter((group) => group.id !== id),
          {
            id,
            windowId: input.windowId,
            title: "",
            color: "grey" as ChromeGroupColor,
            collapsed: false,
            shared: false
          }
        ];
      }
      storage.inventory.tabs = storage.inventory.tabs.map((candidate) =>
        input.tabIds.includes(candidate.id)
          ? { ...candidate, chromeGroupId: id }
          : candidate
      );
      return id;
    },
    async ungroupTabs(tabIds) {
      record("ungroupTabs", [tabIds]);
      maybeThrow("ungroupTabs");
      storage.inventory.tabs = storage.inventory.tabs.map((candidate) =>
        tabIds.includes(candidate.id)
          ? { ...candidate, chromeGroupId: -1 }
          : candidate
      );
    },
    async moveTabs(tabIds, windowId, index) {
      record("moveTabs", [tabIds, windowId, index]);
      maybeThrow("moveTabs");
      storage.inventory.tabs = storage.inventory.tabs.map((candidate) => {
        if (!tabIds.includes(candidate.id)) return candidate;
        return { ...candidate, windowId, index };
      });
    },
    async updateGroup(groupId, patch) {
      record("updateGroup", [groupId, patch]);
      maybeThrow("updateGroup");
      storage.inventory.groups = storage.inventory.groups.map((group) =>
        group.id === groupId ? { ...group, ...patch } : group
      );
    },
    async createTab(input: CreateTabInput) {
      record("createTab", [input]);
      maybeThrow("createTab");
      const window = storage.inventory.windows.find(
        (candidate) => candidate.id === input.windowId
      );
      if (!window || window.incognito) {
        throw new Error("createTab refuses an incognito windowId");
      }
      const id = storage.nextTabId++;
      const tab: ChromeTabSnapshot = {
        id,
        windowId: input.windowId,
        index: input.index ?? storage.inventory.tabs.length,
        chromeGroupId: -1,
        url: input.url,
        status: "complete",
        title: "",
        pinned: false,
        active: input.active ?? false,
        incognito: false,
        lastAccessed: Date.now()
      };
      storage.inventory.tabs = [...storage.inventory.tabs, tab];
      return id;
    },
    async removeTabs(tabIds) {
      record("removeTabs", [tabIds]);
      maybeThrow("removeTabs");
      const remove = new Set(tabIds);
      storage.inventory.tabs = storage.inventory.tabs.filter(
        (tab) => !remove.has(tab.id)
      );
    },
    async moveGroup(groupId, windowId, index) {
      record("moveGroup", [groupId, windowId, index]);
      maybeThrow("moveGroup");
      storage.inventory.groups = storage.inventory.groups.map((group) =>
        group.id === groupId ? { ...group, windowId } : group
      );
      void index;
    },
    async focusTab(tabId, windowId) {
      record("focusTab", [tabId, windowId]);
      maybeThrow("focusTab");
      storage.lastFocusedWindowId = windowId;
      storage.inventory.tabs = storage.inventory.tabs.map((tab) => ({
        ...tab,
        active: tab.id === tabId
      }));
      storage.inventory.windows = storage.inventory.windows.map((window) => ({
        ...window,
        focused: window.id === windowId
      }));
    },
    async restoreClosedTab(sessionId) {
      record("restoreClosedTab", [sessionId]);
      maybeThrow("restoreClosedTab");
      if (!sessionId) throw new Error("restoreClosedTab requires sessionId");
      const entry = storage.recentlyClosed.find(
        (candidate) => candidate.sessionId === sessionId
      );
      const windowId =
        storage.lastFocusedWindowId ??
        storage.inventory.windows[0]?.id ??
        1;
      return port.createTab({
        url: entry?.url ?? "about:blank",
        windowId,
        active: false
      });
    }
  };

  return {
    ...port,
    callsFor(method) {
      return [...(calls.get(method) ?? [])];
    },
    setError(method, error) {
      if (error) errors.set(method, error);
      else errors.delete(method);
    },
    getStorage() {
      return storage;
    },
    getInventory() {
      return storage.inventory;
    }
  };
}

export function reinstantiateFakeChromePort(
  storage: FakeChromeStorage
): ReturnType<typeof createFakeChromePort> {
  return createFakeChromePort(storage.inventory, { storage });
}
