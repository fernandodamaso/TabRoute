import { createLiveChromePort } from "../src/chrome/liveChromePort";
import { createDefaultConfiguration } from "../src/domain/defaults";
import { createTabRouteController } from "../src/controller/controller";
import { createChromeSessionRepository } from "../src/state/sessionRepository";
import { createConfigurationRepository } from "../src/state/configurationRepository";
import { createConfigurationSyncCoordinator } from "../src/state/configurationSyncCoordinator";
import type { ChromeTabSnapshot } from "../src/domain/types";
import type { UiMessage } from "../src/ui/messages";
import { applyChromeGroupPresentation } from "../src/groups/displayTitle";
import { createManagerMessageRouter } from "../src/background/managerMessageRouter";

function toSnapshot(tab: chrome.tabs.Tab): ChromeTabSnapshot | undefined {
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
    lastAccessed: tab.lastAccessed ?? 0
  };
}

export default defineBackground(async () => {
  const repository = createConfigurationRepository({
    storage: {
      sync: chrome.storage.sync,
      local: chrome.storage.local,
      session: chrome.storage.session
    },
    createDefault: () => createDefaultConfiguration()
  });
  const configuration = await repository.loadOrCreate();
  const session = createChromeSessionRepository(chrome.storage.session);
  const controller = createTabRouteController({
    configuration,
    chrome: createLiveChromePort(),
    session
  });
  const managerRouter = createManagerMessageRouter({ repository, controller });
  const configurationSync = createConfigurationSyncCoordinator({
    repository,
    callbacks: {
      replaceConfiguration: (next) => controller.replaceConfiguration(next),
      refreshMenus: async () => undefined,
      refreshAlarms: async () => undefined,
      refreshViews: async () => undefined
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    void configurationSync
      .applySyncChange(Object.keys(changes))
      .catch((error: unknown) =>
        console.error("TabRoute Sync revision application failed", error)
      );
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== "complete") return;
    const snapshot = toSnapshot(tab);
    if (snapshot)
      void controller
        .handleTabUpdated(snapshot)
        .catch((error: unknown) =>
          console.error("TabRoute routing failed", error)
        );
  });

  chrome.tabGroups.onUpdated.addListener((group) => {
    if (
      group.id === undefined ||
      group.windowId === undefined ||
      group.shared ||
      !group.title
    )
      return;
    void (async () => {
      const association = (await session.loadAssociations()).find(
        (candidate) =>
          candidate.chromeGroupId === group.id &&
          candidate.chromeWindowId === group.windowId
      );
      if (!association) return;
      const current = controller.getConfiguration();
      const next = applyChromeGroupPresentation(
        current,
        association.managedGroupId,
        group.title ?? "",
        (group.color ??
          "grey") as import("../src/domain/types").ChromeGroupColor
      );
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      await repository.save(next);
      await controller.replaceConfiguration(next);
    })().catch((error: unknown) =>
      console.error("TabRoute group presentation sync failed", error)
    );
  });

  chrome.runtime.onMessage.addListener((message: UiMessage) => {
    if (message.kind === "manager-query" || message.kind === "manager-command")
      return managerRouter.handle(message);
    return undefined;
  });
});
