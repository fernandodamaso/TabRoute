import { createLiveChromePort } from "../src/chrome/liveChromePort";
import { createDefaultConfiguration } from "../src/domain/defaults";
import { createTabRouteController } from "../src/controller/controller";
import { createChromeSessionRepository } from "../src/state/sessionRepository";
import { createChromeLocalRepository } from "../src/state/localRepository";
import { createConfigurationRepository } from "../src/state/configurationRepository";
import {
  createActivityManagerPort,
  createDiagnosticsManagerPort,
  createManagerMessageRouter,
  createSnapshotManagerPort
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
import { reconstructAssociations } from "../src/chrome/reconstructAssociations";
import {
  ensureSnapshotAlarms,
  handleSnapshotAlarm,
  noteSnapshotRelevantEvent,
  SNAPSHOT_ALARMS
} from "../src/snapshots/snapshotScheduler";
import {
  STARTUP_RECOVERY_ALARM,
  WINDOW_SETTLEMENT_ALARM
} from "../src/persistence/startupCoordinator";
import {
  refreshMenus,
  registerMenus,
  type MenuCommandHost
} from "../src/background/registerMenus";
import { registerCommands } from "../src/background/registerCommands";
import { executeUserCommand, clearPendingRuleDraft, readPendingRuleDraft } from "../src/controller/executeUserCommand";
import { getAvailableUndo } from "../src/activity/activityRepository";
import type { UserCommand } from "../src/controller/userCommands";

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
  let menuHost: MenuCommandHost | undefined;
  const bufferedEvents: ChromeEventHint[] = [];

  async function rebuildMenus() {
    if (!menuHost) return;
    await refreshMenus(chrome, menuHost);
  }

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
    await scheduleWindowSettlementFromSession();
    if (localRef.current && sessionRef.current) {
      await noteSnapshotRelevantEvent(event, {
        configuration: () => controller!.getConfiguration(),
        local: localRef.current,
        session: sessionRef.current,
        reads: controller!.actionDeps().reads,
        alarms: chromeAlarmScheduler
      }).catch((error: unknown) =>
        console.error("TabRoute snapshot checkpoint note failed", error)
      );
    }
  }

  const localRef: { current?: ReturnType<typeof createChromeLocalRepository> } = {};
  const sessionRef = { current: session };
  const chromeAlarmScheduler = {
    schedulePeriodic: async (name: string, periodInMinutes: number) => {
      if (!chrome.alarms?.create) return;
      await chrome.alarms.create(name, { periodInMinutes });
    },
    scheduleOneShot: async (name: string, when: number) => {
      if (!chrome.alarms?.create) return;
      await chrome.alarms.create(name, { when });
    }
  };

  async function scheduleWindowSettlementFromSession() {
    if (!chrome.alarms?.create) return;
    const loaded = await session.loadSession();
    if (loaded.pendingWindowClosures.length === 0) return;
    const deadlines = loaded.pendingWindowClosures.map(
      (pending) => pending.startedAt + 2000
    );
    const when = Math.max(Math.min(...deadlines) - Date.now(), 0);
    await chrome.alarms.create(WINDOW_SETTLEMENT_ALARM, {
      when: Date.now() + when
    });
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
    localRef.current = local;
    const checkpoints = createPreMutationCheckpointService({
      local,
      captureContext: async () => {
        const currentConfiguration = controller!.getConfiguration();
        const inventory = await controller!.actionDeps().reads.readInventory();
        return {
          configuration: currentConfiguration,
          ownership: await local.loadWindowOwnership(),
          associations: reconstructAssociations(inventory, currentConfiguration)
        };
      }
    });
    controller = createTabRouteController({
      configuration,
      chrome: createLiveChromePort(),
      session,
      local,
      checkpoints,
      alarms: chrome.alarms?.create
        ? {
            scheduleOneShot: async (name, when) => {
              await chrome.alarms.create(name, { when });
            }
          }
        : undefined
    });
    await controller.onWorkerWake();
    await ensureSnapshotAlarms(controller.getConfiguration(), chromeAlarmScheduler);
    const activity = createActivityManagerPort({
      local,
      session,
      actionDeps: () => controller!.actionDeps(),
      getConfiguration: () => controller!.getConfiguration()
    });
    const snapshots = createSnapshotManagerPort({
      local,
      session,
      actionDeps: () => controller!.actionDeps(),
      getConfiguration: () => controller!.getConfiguration(),
      readInventory: () => controller!.actionDeps().reads.readInventory()
    });
    const diagnostics = createDiagnosticsManagerPort({
      local,
      session,
      getConfiguration: () => controller!.getConfiguration(),
      applySyncChange: async () =>
        (await configurationSyncRef.current?.applySyncChange()) ?? { kind: "ignored" },
      reconcileAll: async () => {
        const current = controller!.getConfiguration();
        await controller!.replaceConfiguration(current);
      },
      offline: () => typeof navigator !== "undefined" && navigator.onLine === false
    });
    managerRouter = createManagerMessageRouter({
      repository,
      controller,
      activity,
      snapshots,
      diagnostics,
      inventory: {
        readInventory: () => controller!.actionDeps().reads.readInventory(),
        loadPreferredWindowId: async () => {
          const runtime = await session.loadSession();
          return runtime.lastFocusedNormalWindowId;
        },
        loadAssociations: async (configuration, inventory) =>
          reconstructAssociations(inventory, configuration)
      },
      consumePendingRuleDraft: async () => {
        const draft = await readPendingRuleDraft(session);
        if (!draft) return undefined;
        await clearPendingRuleDraft(session);
        return { host: draft.host, url: draft.url };
      }
    });
    menuHost = {
      async executeUserCommand(command: UserCommand) {
        const result = await executeUserCommand(command, {
          getConfiguration: () => controller!.getConfiguration(),
          replaceConfiguration: (next) => controller!.replaceConfiguration(next),
          persistConfiguration: (next) => repository.save(next),
          actionDeps: () => controller!.actionDeps(),
          local,
          session,
          openOptionsPage: async () => {
            await chrome.runtime.openOptionsPage();
          }
        });
        if (result.ok) {
          void rebuildMenus().catch((error: unknown) =>
            console.error("TabRoute menu refresh failed", error)
          );
        }
        return result;
      },
      async readMenuContext() {
        const configuration = controller!.getConfiguration();
        const inventory = await controller!.actionDeps().reads.readInventory();
        const runtime = await session.loadSession();
        const availableUndo = await getAvailableUndo(
          local,
          Date.now(),
          runtime.browserSessionId
        );
        return {
          configuration,
          inventory,
          associations: reconstructAssociations(inventory, configuration),
          checkpointInFlight: runtime.operationGuards.some(
            (guard) => guard.phase === "executing"
          ),
          availableUndoId: availableUndo?.id
        };
      }
    };
    await registerMenus(chrome, menuHost);
    registerCommands(chrome, menuHost);
    const configurationSync = createConfigurationSyncCoordinator({
      repository,
      callbacks: {
        replaceConfiguration: (next) => controller!.replaceConfiguration(next),
        refreshMenus: () => rebuildMenus(),
        refreshAlarms: async () => {
          await ensureSnapshotAlarms(
            controller!.getConfiguration(),
            chromeAlarmScheduler
          );
        },
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
        message.kind !== "activity-query" &&
        message.kind !== "snapshots-query" &&
        message.kind !== "diagnostics-query"
      )
        return undefined;
      void ready
        .then(() => {
          if (!managerRouter) throw new Error("manager router unavailable");
          return managerRouter.handle(message);
        })
        .then((response) => {
          if (message.kind === "manager-command" && response.ok) {
            void rebuildMenus().catch((error: unknown) =>
              console.error("TabRoute menu refresh failed", error)
            );
          }
          sendResponse(response);
        })
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

  chrome.runtime.onInstalled.addListener(() => {
    void ready
      .then(() => rebuildMenus())
      .catch((error: unknown) =>
        console.error("TabRoute onInstalled menu refresh failed", error)
      );
  });

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
    void ready
      .then(() => rebuildMenus())
      .catch((error: unknown) =>
        console.error("TabRoute menu refresh failed", error)
      );
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
    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
      void ready
        .then(() => rebuildMenus())
        .catch((error: unknown) =>
          console.error("TabRoute menu refresh failed", error)
        );
    }
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    enqueueLifecycleEvent({ kind: "windowRemoved", windowId });
  });

  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (
      alarm.name === GROUP_SETTLEMENT_ALARM ||
      alarm.name === WINDOW_SETTLEMENT_ALARM ||
      alarm.name === STARTUP_RECOVERY_ALARM ||
      alarm.name === SNAPSHOT_ALARMS.interval ||
      alarm.name === SNAPSHOT_ALARMS.checkpoint
    ) {
      if (
        alarm.name === SNAPSHOT_ALARMS.interval ||
        alarm.name === SNAPSHOT_ALARMS.checkpoint
      ) {
        void ready
          .then(async () => {
            if (!controller || !localRef.current) return;
            await handleSnapshotAlarm(alarm.name, {
              configuration: () => controller!.getConfiguration(),
              local: localRef.current!,
              session,
              reads: controller!.actionDeps().reads,
              alarms: chromeAlarmScheduler
            });
          })
          .catch((error: unknown) =>
            console.error("TabRoute snapshot alarm failed", error)
          );
        return;
      }
      enqueueLifecycleEvent({ kind: "alarm", name: alarm.name });
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    enqueueLifecycleEvent({ kind: "startup" });
  });

  void ready.catch((error: unknown) => {
    console.error("TabRoute background startup failed", error);
  });
});
