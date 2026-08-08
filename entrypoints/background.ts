import { createLiveChromePort } from "../src/chrome/liveChromePort";
import { createDefaultConfiguration } from "../src/domain/defaults";
import { createTabRouteController } from "../src/controller/controller";
import { createChromeSessionRepository } from "../src/state/sessionRepository";
import { createConfigurationRepository } from "../src/state/configurationRepository";
import type { ChromeTabSnapshot } from "../src/domain/types";

function toSnapshot(tab: chrome.tabs.Tab): ChromeTabSnapshot | undefined {
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

export default defineBackground(async () => {
  const configuration = await createConfigurationRepository({ storage: chrome.storage.local, createDefault: () => createDefaultConfiguration() }).loadOrCreate();
  const controller = createTabRouteController({ configuration, chrome: createLiveChromePort(), session: createChromeSessionRepository(chrome.storage.session) });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== "complete") return;
    const snapshot = toSnapshot(tab);
    if (snapshot) void controller.handleTabUpdated(snapshot).catch((error: unknown) => console.error("TabRoute routing failed", error));
  });
});
