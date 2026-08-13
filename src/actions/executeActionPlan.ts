import { reconstructAssociations } from "../chrome/reconstructAssociations";
import type { ChromeMutationPort, ChromeReadPort, GroupTabsInput } from "../chrome/types";
import { findTab, isRoutableUrl } from "../chrome/types";
import type {
  BrowserInventory,
  ChromeAssociation,
  ChromeInventory,
  Configuration,
  TabSnapshot
} from "../domain/types";
import type { SessionRepository } from "../state/sessionRepository";
import type { LocalRepository } from "../state/localRepository";
import { executeWithRetry } from "./retryPolicy";
import type {
  ActionPlan,
  EngineActionResult,
  PlannedAction,
  TabRef
} from "./types";

export interface PreMutationCheckpointPort {
  captureBefore(plan: ActionPlan, inventory: BrowserInventory): Promise<void>;
}

export interface ActionEngineDeps {
  reads: ChromeReadPort;
  mutations: ChromeMutationPort;
  checkpoints: PreMutationCheckpointPort;
  local: LocalRepository;
  session: SessionRepository;
  configuration: Configuration;
  now: () => number;
  delay: (ms: number) => Promise<void>;
}

function resolveTabRef(
  ref: TabRef,
  outputs: EngineActionResult["outputs"],
  _inventory: ChromeInventory
): number | undefined {
  if (ref.kind === "live") return ref.tabId;
  const output = outputs[ref.actionId];
  if (!output || !("id" in output)) return undefined;
  return output.id;
}

function groupInputForAssign(
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[],
  action: Extract<PlannedAction, { kind: "assignTabsToManagedGroup" }>,
  tabId: number
): GroupTabsInput {
  const tab = findTab(inventory, tabId);
  if (!tab) throw new Error("assign tab missing");
  const existing = associations.find(
    (association) =>
      association.managedGroupId === action.managedGroupId &&
      association.chromeWindowId === action.windowId
  );
  const group =
    existing &&
    inventory.groups.find(
      (candidate) =>
        candidate.id === existing.chromeGroupId &&
        candidate.windowId === action.windowId &&
        !candidate.shared
    );
  if (group) {
    return {
      kind: "existing",
      tabIds: [tabId],
      chromeGroupId: group.id,
      windowId: action.windowId
    };
  }
  return { kind: "create", tabIds: [tabId], windowId: action.windowId };
}

export async function executeActionPlan(
  plan: ActionPlan,
  deps: ActionEngineDeps
): Promise<EngineActionResult> {
  const outputs: EngineActionResult["outputs"] = {};
  const completed: EngineActionResult["completed"] = [];
  let inventory = await deps.reads.readInventory();
  const session = await deps.session.loadSession();
  let associations = reconstructAssociations(inventory, deps.configuration);

  if (plan.checkpoint === "required") {
    try {
      await deps.checkpoints.captureBefore(plan, decorateInventory(inventory, session));
    } catch {
      return {
        actionId: plan.id,
        status: "failure",
        completed: [],
        outputs: {},
        errorCode: "CHECKPOINT_FAILED"
      };
    }
  }

  for (const action of plan.actions) {
    const result = await executePlannedAction(action, {
      deps,
      plan,
      outputs,
      inventory,
      associations
    });
    if (result.status === "failure") {
      return {
        actionId: plan.id,
        status: "failure",
        completed,
        outputs,
        errorCode: result.errorCode
      };
    }
    if (result.output) outputs[action.id] = result.output;
    completed.push(action.id);
    inventory = await deps.reads.readInventory();
    associations = reconstructAssociations(inventory, deps.configuration);
  }

  return { actionId: plan.id, status: "success", completed, outputs };
}

function decorateInventory(
  inventory: ChromeInventory,
  _session: import("../domain/types").RuntimeSession
): BrowserInventory {
  return {
    ...inventory,
    tabs: inventory.tabs.map((tab) => ({
      ...tab,
      routing: isRoutableUrl(tab.url)
        ? { kind: "routable" as const, url: tab.url }
        : { kind: "pending" as const }
    }))
  };
}

async function executePlannedAction(
  action: PlannedAction,
  context: {
    deps: ActionEngineDeps;
    plan: ActionPlan;
    outputs: EngineActionResult["outputs"];
    inventory: ChromeInventory;
    associations: ChromeAssociation[];
  }
): Promise<{
  status: "success" | "failure";
  output?: TabSnapshot | { chromeGroupId: number };
  errorCode?: string;
}> {
  const { deps, outputs, inventory, associations } = context;
  const delay = deps.delay;

  async function refresh() {
    return deps.reads.readInventory();
  }

  switch (action.kind) {
    case "createTab": {
      const tabId = await executeWithRetry(
        () =>
          deps.mutations.createTab({
            url: action.input.url,
            windowId: action.input.windowId,
            active: action.input.active ?? false,
            index: action.input.index
          }),
        refresh,
        delay
      );
      const after = await refresh();
      const tab = findTab(after, tabId);
      if (!tab) return { status: "failure", errorCode: "TAB_MISSING" };
      return { status: "success", output: tab };
    }
    case "restoreClosedTab": {
      const tabId = await executeWithRetry(
        () => deps.mutations.restoreClosedTab(action.sessionId),
        refresh,
        delay
      );
      const after = await refresh();
      const tab = findTab(after, tabId);
      if (!tab) return { status: "failure", errorCode: "TAB_MISSING" };
      return { status: "success", output: tab };
    }
    case "moveTabs": {
      const tabIds = action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
      if (tabIds.length === 0) return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.moveTabs(
            tabIds as [number, ...number[]],
            action.windowId,
            action.index
          ),
        refresh,
        delay
      );
      return { status: "success" };
    }
    case "assignTabsToManagedGroup": {
      const tabId = resolveTabRef(action.tabs[0]!, outputs, inventory);
      if (tabId === undefined) return { status: "failure", errorCode: "TAB_MISSING" };
      const input = groupInputForAssign(inventory, associations, action, tabId);
      const chromeGroupId = await executeWithRetry(
        () => deps.mutations.groupTabs(input),
        refresh,
        delay
      );
      await executeWithRetry(
        () =>
          deps.mutations.updateGroup(chromeGroupId, {
            title: action.title,
            color: action.color,
            ...(action.collapsed === undefined ? {} : { collapsed: action.collapsed })
          }),
        refresh,
        delay
      );
      return { status: "success", output: { chromeGroupId } };
    }
    case "ungroupTabs": {
      const tabIds = action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
      if (tabIds.length === 0) return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () => deps.mutations.ungroupTabs(tabIds as [number, ...number[]]),
        refresh,
        delay
      );
      return { status: "success" };
    }
    case "focusTab": {
      const tabId = resolveTabRef(action.tab, outputs, inventory);
      if (tabId === undefined) return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () => deps.mutations.focusTab(tabId, action.windowId),
        refresh,
        delay
      );
      return { status: "success" };
    }
    case "closeDuplicate": {
      const duplicateId = resolveTabRef(action.duplicate, outputs, inventory);
      const survivorId = resolveTabRef(action.survivor, outputs, inventory);
      if (duplicateId === undefined || survivorId === undefined) {
        return { status: "failure", errorCode: "TAB_MISSING" };
      }
      const fresh = await refresh();
      const duplicate = findTab(fresh, duplicateId);
      const survivor = findTab(fresh, survivorId);
      if (!duplicate || !survivor) {
        return { status: "failure", errorCode: "TAB_MISSING" };
      }
      const duplicateGroup = fresh.groups.find(
        (group) => group.id === duplicate.chromeGroupId
      );
      if (duplicateGroup?.shared) {
        return { status: "success" };
      }
      if (!survivor.url || !isRoutableUrl(survivor.url)) {
        return { status: "failure", errorCode: "SURVIVOR_INVALID" };
      }
      try {
        await executeWithRetry(
          () => deps.mutations.removeTabs([duplicateId]),
          refresh,
          delay
        );
      } catch {
        return { status: "failure", errorCode: "CLOSE_FAILED" };
      }
      return { status: "success" };
    }
    case "assignTabsToUnmanagedGroup": {
      const tabIds = action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
      if (tabIds.length === 0) return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.groupTabs({
            kind: "existing",
            tabIds: tabIds as [number, ...number[]],
            chromeGroupId: action.chromeGroupId,
            windowId: action.windowId
          }),
        refresh,
        delay
      );
      return { status: "success" };
    }
    case "updateManagedGroup": {
      const association = associations.find(
        (candidate) => candidate.managedGroupId === action.managedGroupId
      );
      if (!association) return { status: "failure", errorCode: "GROUP_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.updateGroup(association.chromeGroupId, action.patch),
        refresh,
        delay
      );
      return { status: "success" };
    }
    case "moveManagedGroup": {
      const association = associations.find(
        (candidate) => candidate.managedGroupId === action.managedGroupId
      );
      if (!association) return { status: "failure", errorCode: "GROUP_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.moveGroup(
            association.chromeGroupId,
            action.windowId,
            action.index
          ),
        refresh,
        delay
      );
      return { status: "success" };
    }
    case "reorderTabs": {
      const tabIds = action.tabs
        .map((ref) => resolveTabRef(ref, outputs, inventory))
        .filter((id): id is number => id !== undefined);
      if (tabIds.length === 0) return { status: "failure", errorCode: "TAB_MISSING" };
      await executeWithRetry(
        () =>
          deps.mutations.moveTabs(
            tabIds as [number, ...number[]],
            action.windowId,
            action.index
          ),
        refresh,
        delay
      );
      return { status: "success" };
    }
    default:
      return { status: "failure", errorCode: "UNSUPPORTED" };
  }
}
