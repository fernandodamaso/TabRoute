import { createLiveChromePort } from "../src/chrome/liveChromePort";
import { createDefaultConfiguration } from "../src/domain/defaults";
import { createTabRouteController } from "../src/controller/controller";
import { createChromeSessionRepository } from "../src/state/sessionRepository";
import { createChromeLocalRepository } from "../src/state/localRepository";
import { createConfigurationRepository } from "../src/state/configurationRepository";
import {
  createActivityManagerPort,
  createManagerMessageRouter
} from "../src/background/managerMessageRouter";
import { createPreMutationCheckpointService } from "../src/snapshots/checkpointService";
import {
  CONFIGURATION_SYNC_RETRY_ALARM,
  createConfigurationSyncCoordinator,
  registerConfigurationSyncIntake
} from "../src/state/configurationSyncCoordinator";
import type {
  ChromeEventHint,
  ChromeGroupColor,
  ChromeTabSnapshot
} from "../src/domain/types";
import type { UiMessage } from "../src/ui/messages";
import { applyChromeGroupPresentation } from "../src/groups/displayTitle";
import { GROUP_SETTLEMENT_ALARM } from "../src/groups/groupLifecycle";

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

function toGroupSnapshot(group: chrome.tabGroups.TabGroup) {
  if (group.id === undefined || group.windowId === undefined) return undefined;
  return {
    id: group.id,
    windowId: group.windowId,
    title: group.title ?? "",
    color: (group.color ?? "grey") as ChromeGroupColor,
    collapsed: group.collapsed ?? false,
    shared: group.shared ?? false
  };
}

function focusHint(windowId: number): ChromeEventHint {
  if (windowId === chrome.windows.WINDOW_ID_NONE)
    return { kind: "windowFocusChanged", focus: { kind: "none" } };
  return {
    kind: "windowFocusChanged",
    focus: { kind: "normal", windowId }
  };
}

export default defineBackground(() => {
  const session = createChromeSessionRepository(chrome.storage.session);
  const repository = createConfigurationRepository({
    storage: {
      sync: chrome.storage.sync,
      local: chrome.storage.local,
      session: chrome.storage.session
    },
    createDefault: () => createDefaultConfiguration(),
    sessionRepository: session
  });
  const configurationSyncRef: {
    current?: ReturnType<typeof createConfigurationSyncCoordinator>;
  } = {};
  const intake = registerConfigurationSyncIntake({
    storageOnChanged: chrome.storage.onChanged,
    alarmsOnAlarm: chrome.alarms?.onAlarm ?? { addListener() {} },
    dispatch(changedKeys) {
      const configurationSync = configurationSyncRef.current;
      if (!configurationSync) return;
      void configurationSync
        .applySyncChange(changedKeys)
        .catch((error: unknown) =>
          console.error("TabRoute Sync revision application failed", error)
        );
    }
  });

  let managerRouter: ReturnType<typeof createManagerMessageRouter> | undefined;
  let controller: ReturnType<typeof createTabRouteController> | undefined;
  const bufferedEvents: ChromeEventHint[] = [];

  async function scheduleGroupSettlementFromSession() {
    if (!chrome.alarms?.create) return;
    const loaded = await session.loadSession();
    const deadlines = [
      ...loaded.pendingGroupRemovals.map((pending) => pending.settleAfter),
      ...loaded.operationGuards
        .filter(
          (guard) => guard.phase === "settling" && guard.settleAfter !== undefined
        )
        .map((guard) => guard.settleAfter!)
    ];
    if (deadlines.length === 0) return;
    const when = Math.max(Math.min(...deadlines) - Date.now(), 0);
    await chrome.alarms.create(GROUP_SETTLEMENT_ALARM, {
      when: Date.now() + when
    });
  }

  async function processLifecycleEvent(event: ChromeEventHint) {
    if (!controller) return;
    await controller.handleChromeEvent(event).catch((error: unknown) =>
      console.error("TabRoute lifecycle event failed", error)
    );
    await scheduleGroupSettlementFromSession();
  }

  function enqueueLifecycleEvent(event: ChromeEventHint) {
    if (!controller) {
      bufferedEvents.push(event);
      return;
    }
    void processLifecycleEvent(event);
  }

  const ready = (async () => {
    const configuration = await repository.loadOrCreate();
    const local = createChromeLocalRepository(
      chrome.storage.local,
      chrome.storage.sync,
      chrome.storage.session
    );
    const checkpoints = createPreMutationCheckpointService({
      local,
      captureContext: async () => ({
        configuration,
        ownership: await local.loadWindowOwnership()
      })
    });
    controller = createTabRouteController({
      configuration,
      chrome: createLiveChromePort(),
      session,
      local,
      checkpoints
    });
    await controller.onWorkerWake();
    const activity = createActivityManagerPort({
      local,
      session,
      actionDeps: () => controller!.actionDeps(),
      getConfiguration: () => controller!.getConfiguration()
    });
    managerRouter = createManagerMessageRouter({ repository, controller, activity });
    const configurationSync = createConfigurationSyncCoordinator({
      repository,
      callbacks: {
        replaceConfiguration: (next) => controller!.replaceConfiguration(next),
        refreshMenus: async () => undefined,
        refreshAlarms: async () => undefined,
        refreshViews: async () => undefined,
        scheduleRetry: async () => {
          if (!chrome.alarms?.create) return;
          await chrome.alarms.create(CONFIGURATION_SYNC_RETRY_ALARM, {
            delayInMinutes: 1
          });
        }
      },
      recordSyncActivity: { local, now: () => Date.now() }
    });
    configurationSyncRef.current = configurationSync;
    const startupSync = intake.markReady();
    void configurationSync
      .applySyncChange(startupSync.changedKeys)
      .catch((error: unknown) =>
        console.error("TabRoute Sync revision application failed", error)
      );
    for (const event of bufferedEvents.splice(0)) {
      await processLifecycleEvent(event);
    }
  })();

  chrome.runtime.onMessage.addListener(
    (message: UiMessage, _sender, sendResponse) => {
      if (
        message.kind !== "manager-query" &&
        message.kind !== "manager-command" &&
        message.kind !== "activity-query"
      )
        return undefined;
      void ready
        .then(() => {
          if (!managerRouter) throw new Error("manager router unavailable");
          return managerRouter.handle(message);
        })
        .then((response) => sendResponse(response))
        .catch((error: unknown) => {
          console.error("TabRoute manager message failed", error);
          sendResponse({
            ok: false,
            error: {
              kind: "transport",
              code: "BACKGROUND_STARTUP_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : "manager router unavailable"
            }
          });
        });
      return true;
    }
  );

  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id === undefined) return;
    enqueueLifecycleEvent({ kind: "tabCreated", tabId: tab.id });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const snapshot = toSnapshot(tab);
    if (!snapshot) return;
    enqueueLifecycleEvent({
      kind: "tabUpdated",
      tabId,
      urlChanged: changeInfo.url !== undefined,
      groupChanged: changeInfo.groupId !== undefined,
      pinnedChanged: changeInfo.pinned !== undefined
    });
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    enqueueLifecycleEvent({
      kind: "tabActivated",
      tabId: activeInfo.tabId,
      windowId: activeInfo.windowId
    });
  });

  chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
    enqueueLifecycleEvent({
      kind: "tabMoved",
      tabId,
      windowId: moveInfo.windowId,
      fromIndex: moveInfo.fromIndex,
      toIndex: moveInfo.toIndex
    });
  });

  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    enqueueLifecycleEvent({
      kind: "tabAttached",
      tabId,
      newWindowId: attachInfo.newWindowId,
      newPosition: attachInfo.newPosition
    });
  });

  chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    enqueueLifecycleEvent({
      kind: "tabDetached",
      tabId,
      oldWindowId: detachInfo.oldWindowId,
      oldPosition: detachInfo.oldPosition
    });
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    enqueueLifecycleEvent({
      kind: "tabRemoved",
      tabId,
      windowId: removeInfo.windowId,
      isWindowClosing: removeInfo.isWindowClosing
    });
  });

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    enqueueLifecycleEvent({ kind: "tabReplaced", addedTabId, removedTabId });
  });

  chrome.tabGroups.onCreated.addListener((group) => {
    const snapshot = toGroupSnapshot(group);
    if (!snapshot) return;
    enqueueLifecycleEvent({ kind: "groupCreated", group: snapshot });
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
      await ready;
      if (!controller) return;
      const association = (await session.loadAssociations()).find(
        (candidate) =>
          candidate.chromeGroupId === group.id &&
          candidate.chromeWindowId === group.windowId
      );
      if (!association) {
        const snapshot = toGroupSnapshot(group);
        if (snapshot) enqueueLifecycleEvent({ kind: "groupUpdated", group: snapshot });
        return;
      }
      const current = controller.getConfiguration();
      const next = applyChromeGroupPresentation(
        current,
        association.managedGroupId,
        group.title ?? "",
        (group.color ?? "grey") as ChromeGroupColor
      );
      if (JSON.stringify(next) === JSON.stringify(current)) {
        const snapshot = toGroupSnapshot(group);
        if (snapshot) enqueueLifecycleEvent({ kind: "groupUpdated", group: snapshot });
        return;
      }
      await repository.save(next);
      await controller.replaceConfiguration(next);
    })().catch((error: unknown) =>
      console.error("TabRoute group presentation sync failed", error)
    );
  });

  chrome.tabGroups.onMoved.addListener((group) => {
    const snapshot = toGroupSnapshot(group);
    if (!snapshot) return;
    enqueueLifecycleEvent({ kind: "groupMoved", group: snapshot });
  });

  chrome.tabGroups.onRemoved.addListener((group) => {
    if (group.id === undefined || group.windowId === undefined) return;
    enqueueLifecycleEvent({
      kind: "groupRemoved",
      group: {
        id: group.id,
        windowId: group.windowId,
        title: group.title ?? "",
        color: (group.color ?? "grey") as ChromeGroupColor,
        collapsed: group.collapsed ?? false,
        shared: group.shared ?? false
      }
    });
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    enqueueLifecycleEvent(focusHint(windowId));
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    enqueueLifecycleEvent({ kind: "windowRemoved", windowId });
  });

  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === GROUP_SETTLEMENT_ALARM) {
      enqueueLifecycleEvent({ kind: "alarm", name: alarm.name });
    }
  });

  void ready.catch((error: unknown) => {
    console.error("TabRoute background startup failed", error);
  });
});
