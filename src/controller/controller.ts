import { reconstructAssociations } from "../chrome/reconstructAssociations";
import type { ChromeMutationPort } from "../chrome/types";
import { isRoutableUrl } from "../chrome/types";
import type {
  Configuration,
  ChromeInventory,
  ChromeTabSnapshot,
  ChromeEventHint
} from "../domain/types";
import { postconditionHolds, settleOperationGuards } from "../actions/operationGuards";
import { executeActionPlan } from "../actions/executeActionPlan";
import { planRuleRoute } from "../actions/planActions";
import { scrubRuntimeState } from "../state/runtimeSession";
import type { SessionRepository } from "../state/sessionRepository";
import { settlePendingGroupRemovals } from "../groups/groupLifecycle";
import {
  classifyChromeEvent,
  type EventClassification,
  type ReconciliationRequest
} from "./eventClassifier";
import type { ActionResult } from "../actions/types";

type QueueItem = ReconciliationRequest;

export function createTabRouteController(input: {
  configuration: Configuration;
  chrome: ChromeMutationPort;
  session: SessionRepository;
  now?: () => number;
}) {
  const now = () => input.now?.() ?? Date.now();
  let configuration = input.configuration;
  const pendingTabs = new Set<number>();
  const queue: QueueItem[] = [];
  let drainPromise: Promise<void> | undefined;
  let executing = false;
  let eventChain: Promise<void> = Promise.resolve();

  async function currentAssociations(inventory: ChromeInventory) {
    const stored = await input.session.loadSession();
    const groupIds = new Set(inventory.groups.map((group) => group.id));
    const windowIds = new Set(inventory.windows.map((window) => window.id));
    const preserved = stored.associations.filter(
      (association) =>
        !groupIds.has(association.chromeGroupId) ||
        !windowIds.has(association.chromeWindowId)
    );
    const rebuilt = reconstructAssociations(inventory, configuration);
    const merged = new Map(
      preserved.map((association) => [
        `${association.managedGroupId}:${association.chromeWindowId}`,
        association
      ])
    );
    for (const association of rebuilt) {
      merged.set(
        `${association.managedGroupId}:${association.chromeWindowId}`,
        association
      );
    }
    const associations = [...merged.values()];
    if (associations.length > 0) {
      await input.session.saveSession({ ...stored, associations });
    }
    return associations;
  }

  async function reconcileTab(tab: ChromeTabSnapshot): Promise<ActionResult> {
    if (tab.incognito || !isRoutableUrl(tab.url))
      return { kind: "held", reason: "not-routable" };
    const inventory = await input.chrome.readInventory();
    let runtime = await input.session.loadSession();
    const settledRuntime = settleOperationGuards(inventory, runtime, now());
    if (settledRuntime !== runtime) {
      await input.session.saveSession(settledRuntime);
      runtime = settledRuntime;
    }
    const override = runtime.manualOverrides[String(tab.id)];
    if (override?.placement.kind === "leaveWherePlaced")
      return { kind: "held", reason: "unmanaged-placement" };
    if (
      override?.placement.kind === "managedGroup" ||
      override?.placement.kind === "ungrouped"
    )
      return { kind: "held", reason: "manual-override" };
    const guarded = runtime.operationGuards.some((guard) => {
      if (!guard.tabIds.includes(tab.id)) return false;
      if (guard.phase === "executing") return true;
      if (guard.phase !== "settling") return false;
      if (!guard.postcondition) return true;
      return postconditionHolds(guard.postcondition, inventory);
    });
    if (guarded) {
      pendingTabs.add(tab.id);
      return { kind: "held", reason: "not-routable" };
    }
    const freshTab =
      inventory.tabs.find((candidate) => candidate.id === tab.id) ?? tab;
    const associations = await currentAssociations(inventory);
    if (
      !configuration.automationEnabled ||
      configuration.globalPausedUntil === "restart" ||
      (typeof configuration.globalPausedUntil === "number" &&
        configuration.globalPausedUntil > now())
    )
      return { kind: "held", reason: "paused" };
    const planned = planRuleRoute({
      inventory,
      tab: freshTab,
      configuration,
      associations,
      intentionallyClosedGroupIds: runtime.intentionallyClosedGroupIds
    });
    if (planned.kind === "held" || planned.kind === "noop") return planned;
    executing = true;
    try {
      const result = await executeActionPlan(planned, {
        chrome: input.chrome,
        session: input.session,
        now
      });
      if (result.kind === "executed") {
        await input.session.saveAssociations(
          reconstructAssociations(result.inventory, configuration)
        );
      }
      return result;
    } finally {
      executing = false;
      await flushDeferredTabs();
    }
  }

  function enqueue(request: QueueItem) {
    if (request.scope.kind === "tab") {
      const tabId = request.scope.tabId;
      pendingTabs.add(tabId);
      const existing = queue.findIndex(
        (item) => item.scope.kind === "tab" && item.scope.tabId === tabId
      );
      if (existing >= 0) queue.splice(existing, 1);
    }
    queue.push(request);
    void drainQueue();
  }

  async function flushDeferredTabs() {
    if (pendingTabs.size === 0) return;
    const session = await input.session.loadSession();
    const inventory = await input.chrome.readInventory();
    const hasBlockingExecuting = session.operationGuards.some(
      (guard) =>
        guard.phase === "executing" &&
        guard.tabIds.some((tabId) => pendingTabs.has(tabId))
    );
    if (hasBlockingExecuting) return;
    for (const tabId of [...pendingTabs]) {
      pendingTabs.delete(tabId);
      const tab = inventory.tabs.find((candidate) => candidate.id === tabId);
      if (tab) enqueue({ scope: { kind: "tab", tabId }, reason: "deferred" });
    }
  }

  async function drainQueue(): Promise<void> {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      while (queue.length > 0 && !executing) {
        const request = queue.shift()!;
        if (request.scope.kind === "tab") {
          const tabId = request.scope.tabId;
          const inventory = await input.chrome.readInventory();
          const tab = inventory.tabs.find((candidate) => candidate.id === tabId);
          if (tab) await reconcileTab(tab);
        } else if (request.scope.kind === "all") {
          const inventory = await input.chrome.readInventory();
          for (const tab of inventory.tabs) await reconcileTab(tab);
        }
      }
    })().finally(() => {
      drainPromise = undefined;
      if (queue.length > 0 && !executing) void drainQueue();
    });
    return drainPromise;
  }

  async function classifyAndSave(event: ChromeEventHint) {
    const inventory = await input.chrome.readInventory();
    const session = await input.session.loadSession();
    const sessionWithAssociations = {
      ...session,
      associations: [...(await currentAssociations(inventory))]
    };
    const classification = classifyChromeEvent(
      event,
      inventory,
      sessionWithAssociations,
      now(),
      configuration
    );
    await input.session.saveSession(classification.session);
    return { classification, inventory };
  }

  async function handleChromeEventInner(
    event: ChromeEventHint
  ): Promise<EventClassification> {
    const { classification } = await classifyAndSave(event);
    if (classification.deferred) {
      for (const request of classification.requests) {
        if (request.scope.kind === "tab")
          pendingTabs.add(request.scope.tabId);
      }
      const tabId =
        event.kind === "tabUpdated" ||
        event.kind === "tabMoved" ||
        event.kind === "tabAttached" ||
        event.kind === "tabCreated" ||
        event.kind === "tabActivated"
          ? event.tabId
          : undefined;
      if (tabId !== undefined) pendingTabs.add(tabId);
      return classification;
    }
    if (classification.manualOverride) return classification;
    for (const request of classification.requests) enqueue(request);
    await drainQueue();
    return classification;
  }

  return {
    handleChromeEvent(event: ChromeEventHint): Promise<EventClassification> {
      const result = eventChain.then(() => handleChromeEventInner(event));
      eventChain = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
    async handleTabUpdated(tab: ChromeTabSnapshot): Promise<ActionResult> {
      if (!isRoutableUrl(tab.url))
        return { kind: "held", reason: "not-routable" };
      const runtime = await input.session.loadSession();
      const override = runtime.manualOverrides[String(tab.id)];
      if (override?.placement.kind === "leaveWherePlaced")
        return { kind: "held", reason: "unmanaged-placement" };
      if (
        override?.placement.kind === "managedGroup" ||
        override?.placement.kind === "ungrouped"
      )
        return { kind: "held", reason: "manual-override" };
      const deferred = runtime.operationGuards.some(
        (guard) =>
          guard.phase === "executing" && guard.tabIds.includes(tab.id)
      );
      if (deferred) return { kind: "held", reason: "not-routable" };
      const inventory = await input.chrome.readInventory();
      const fresh =
        inventory.tabs.find((candidate) => candidate.id === tab.id) ?? tab;
      return reconcileTab(fresh);
    },
    async onWorkerWake(): Promise<void> {
      const inventory = await input.chrome.readInventory();
      let session = await input.session.loadSession();
      session = scrubRuntimeState(session, inventory);
      session = settleOperationGuards(inventory, session, now());
      session = settlePendingGroupRemovals({
        session,
        inventory,
        configuration,
        now: now()
      });
      await input.session.saveSession(session);
      for (const guard of session.operationGuards) {
        if (guard.phase === "settling") {
          for (const tabId of guard.tabIds) pendingTabs.add(tabId);
        }
      }
      await flushDeferredTabs();
      await drainQueue();
    },
    async replaceConfiguration(nextConfiguration: Configuration) {
      configuration = nextConfiguration;
      const inventory = await input.chrome.readInventory();
      for (const tab of inventory.tabs) {
        enqueue({ scope: { kind: "tab", tabId: tab.id }, reason: "config" });
      }
      await drainQueue();
    },
    getConfiguration() {
      return configuration;
    }
  };
}
