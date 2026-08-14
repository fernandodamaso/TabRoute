import { buildActionPlan } from "../actions/buildActionPlan";
import {
  executeActionPlan,
  type ActionEngineDeps
} from "../actions/executeActionPlan";
import { executeUndo } from "../activity/executeUndo";
import { getAvailableUndo } from "../activity/activityRepository";
import { findTab, isRoutableUrl } from "../chrome/types";
import { reconstructAssociations } from "../chrome/reconstructAssociations";
import { createUuid } from "../domain/ids";
import { renderGroupTitle } from "../groups/displayTitle";
import {
  makePersistentDefinition,
  pinGroupDefinitions,
  removePersistent
} from "../persistence/persistentCommands";
import { collectLiveMemberUrls } from "../persistence/requirements";
import { setAutomationEnabled } from "../settings/settingsCommands";
import {
  buildSnapshotContext,
  saveNamedSnapshot
} from "../snapshots/snapshotService";
import { observeInventory } from "../duplicates/observations";
import type {
  ActionId,
  ChromeAssociation,
  ChromeInventory,
  Configuration,
  UUID
} from "../domain/types";
import type { LocalRepository } from "../state/localRepository";
import type { SessionRepository } from "../state/sessionRepository";
import type { CommandResult, UserCommand } from "./userCommands";
import type { PlannedAction } from "../actions/types";

export const PENDING_RULE_DRAFT_KEY = "pending-rule-draft:v1";

export type PendingRuleDraft = {
  schemaVersion: 1;
  url: string;
  host: string;
  createdAt: number;
};

export interface UserCommandExecutorDeps {
  getConfiguration(): Configuration;
  replaceConfiguration(configuration: Configuration): Promise<void>;
  persistConfiguration(configuration: Configuration): Promise<void>;
  actionDeps(): ActionEngineDeps;
  local: LocalRepository;
  session: SessionRepository;
  openOptionsPage(): Promise<void>;
  now?: () => number;
  randomUuid?: () => string;
}

function isPaused(value: number | "restart" | undefined, at: number): boolean {
  return value === "restart" || (typeof value === "number" && value > at);
}

async function persist(
  deps: UserCommandExecutorDeps,
  next: Configuration
): Promise<void> {
  await deps.persistConfiguration(next);
  await deps.replaceConfiguration(next);
}

async function runUserPlan(
  deps: UserCommandExecutorDeps,
  actions: PlannedAction[]
): Promise<CommandResult> {
  const plan = buildActionPlan("user", actions);
  const result = await executeActionPlan(plan, deps.actionDeps());
  if (result.status === "failure") {
    return {
      ok: false,
      code: result.errorCode ?? "ACTION_FAILED",
      message: "user command action failed"
    };
  }
  return {
    ok: true,
    actionId: plan.id,
    degraded: result.status === "degraded"
  };
}

export async function executeUserCommand(
  command: UserCommand,
  deps: UserCommandExecutorDeps
): Promise<CommandResult> {
  const now = deps.now ?? Date.now;
  const randomUuid = deps.randomUuid ?? (() => crypto.randomUUID());
  const configuration = deps.getConfiguration();
  const actionDeps = deps.actionDeps();

  switch (command.kind) {
    case "openManager": {
      await deps.openOptionsPage();
      return { ok: true };
    }
    case "createRuleFromTab": {
      const inventory = await actionDeps.reads.readInventory();
      const tab = findTab(inventory, command.tabId);
      if (!tab?.url || !isRoutableUrl(tab.url) || tab.incognito) {
        return {
          ok: false,
          code: "UNSUPPORTED_TAB",
          message: "tab is not eligible"
        };
      }
      const draft: PendingRuleDraft = {
        schemaVersion: 1,
        url: tab.url,
        host: new URL(tab.url).hostname,
        createdAt: now()
      };
      await deps.session.updateRuntime({ [PENDING_RULE_DRAFT_KEY]: draft });
      await deps.openOptionsPage();
      return { ok: true };
    }
    case "toggleAutomation": {
      await persist(
        deps,
        setAutomationEnabled(
          configuration,
          !configuration.automationEnabled,
          now
        )
      );
      return { ok: true };
    }
    case "makePersistent": {
      const inventory = await actionDeps.reads.readInventory();
      const tab = findTab(inventory, command.tabId);
      if (!tab?.url || !isRoutableUrl(tab.url)) {
        return {
          ok: false,
          code: "UNSUPPORTED_TAB",
          message: "tab is not eligible"
        };
      }
      await persist(
        deps,
        makePersistentDefinition(
          configuration,
          command.managedGroupId,
          tab.url,
          now,
          randomUuid
        )
      );
      return { ok: true };
    }
    case "removePersistent": {
      await persist(
        deps,
        removePersistent(configuration, command.persistentTabId, now)
      );
      return { ok: true };
    }
    case "pinGroup": {
      const inventory = await actionDeps.reads.readInventory();
      const associations = reconstructAssociations(inventory, configuration);
      const memberUrls = collectLiveMemberUrls(
        command.managedGroupId,
        configuration,
        inventory,
        associations,
        inventory.windows.find((window) => window.focused)?.id
      );
      await persist(
        deps,
        pinGroupDefinitions(
          configuration,
          command.managedGroupId,
          memberUrls,
          now,
          randomUuid
        )
      );
      return { ok: true };
    }
    case "moveToOther": {
      const inventory = await actionDeps.reads.readInventory();
      const tab = findTab(inventory, command.tabId);
      const group = configuration.groups.find(
        (candidate) => candidate.id === configuration.fallbackGroupId
      );
      if (!tab || tab.incognito || !isRoutableUrl(tab.url) || !group) {
        return {
          ok: false,
          code: "UNSUPPORTED_TAB",
          message: "tab is not eligible"
        };
      }
      return runUserPlan(deps, [
        {
          id: createUuid(randomUuid) as unknown as ActionId,
          kind: "assignTabsToManagedGroup",
          dependsOn: [],
          tabs: [{ kind: "live", tabId: tab.id }],
          managedGroupId: group.id,
          windowId: tab.windowId,
          title: renderGroupTitle(group),
          color: group.color
        }
      ]);
    }
    case "moveToGroup": {
      const inventory = await actionDeps.reads.readInventory();
      const tab = findTab(inventory, command.tabId);
      const group = configuration.groups.find(
        (candidate) => candidate.id === command.managedGroupId
      );
      if (
        !tab ||
        tab.incognito ||
        !isRoutableUrl(tab.url) ||
        !group ||
        !group.enabled ||
        group.isFallback
      ) {
        return {
          ok: false,
          code: "UNSUPPORTED_TAB",
          message: "move target unavailable"
        };
      }
      return runUserPlan(deps, [
        {
          id: createUuid(randomUuid) as unknown as ActionId,
          kind: "assignTabsToManagedGroup",
          dependsOn: [],
          tabs: [{ kind: "live", tabId: tab.id }],
          managedGroupId: group.id,
          windowId: tab.windowId,
          title: renderGroupTitle(group),
          color: group.color
        }
      ]);
    }
    case "setGroupCollapsed": {
      const group = configuration.groups.find(
        (candidate) => candidate.id === command.managedGroupId
      );
      if (!group) {
        return { ok: false, code: "GROUP_MISSING", message: "group not found" };
      }
      return runUserPlan(deps, [
        {
          id: createUuid(randomUuid) as unknown as ActionId,
          kind: "updateManagedGroup",
          dependsOn: [],
          managedGroupId: group.id,
          patch: { collapsed: command.collapsed }
        }
      ]);
    }
    case "excludeFromDuplicates": {
      const inventory = await actionDeps.reads.readInventory();
      const tab = findTab(inventory, command.tabId);
      if (!tab?.url || !isRoutableUrl(tab.url)) {
        return {
          ok: false,
          code: "UNSUPPORTED_TAB",
          message: "tab is not eligible"
        };
      }
      const exclusions = new Set(
        configuration.duplicateSettings.globalExclusions
      );
      exclusions.add(tab.url);
      await persist(deps, {
        ...configuration,
        duplicateSettings: {
          ...configuration.duplicateSettings,
          globalExclusions: [...exclusions]
        },
        updatedAt: now()
      });
      return { ok: true };
    }
    case "setPause": {
      let next = configuration;
      const pausedUntil =
        command.duration.kind === "resume"
          ? undefined
          : command.duration.kind === "restart"
            ? "restart"
            : command.duration.timestamp;
      if (command.target.kind === "global") {
        next = {
          ...configuration,
          globalPausedUntil: pausedUntil,
          updatedAt: now()
        };
      } else if (command.target.kind === "group") {
        const targetId = command.target.id;
        next = {
          ...configuration,
          groups: configuration.groups.map((group) =>
            group.id !== targetId
              ? group
              : { ...group, pausedUntil, updatedAt: now() }
          ),
          updatedAt: now()
        };
      } else {
        const targetId = command.target.id;
        next = {
          ...configuration,
          rules: configuration.rules.map((rule) =>
            rule.id !== targetId
              ? rule
              : { ...rule, pausedUntil, updatedAt: now() }
          ),
          updatedAt: now()
        };
      }
      await persist(deps, next);
      return { ok: true };
    }
    case "saveSnapshot": {
      const inventory = await actionDeps.reads.readInventory();
      const session = await deps.session.loadSession();
      if (
        session.operationGuards.some((guard) => guard.phase === "executing")
      ) {
        return {
          ok: false,
          code: "CHECKPOINT_IN_FLIGHT",
          message: "checkpoint in flight"
        };
      }
      const observed = observeInventory(inventory, session);
      const context = await buildSnapshotContext({
        configuration,
        local: deps.local,
        inventory
      });
      const saved = await saveNamedSnapshot({
        local: deps.local,
        name: command.name,
        scope: command.scope,
        inventory: observed.inventory,
        context,
        now
      });
      if (!saved.ok) {
        return {
          ok: false,
          code: saved.code,
          message: saved.message ?? saved.code
        };
      }
      return { ok: true };
    }
    case "undo": {
      const session = await deps.session.loadSession();
      const available = await getAvailableUndo(
        deps.local,
        now(),
        session.browserSessionId
      );
      if (!available || available.id !== command.undoId) {
        return { ok: true };
      }
      await executeUndo({
        undoId: command.undoId,
        local: deps.local,
        session: deps.session,
        deps: actionDeps,
        configuration,
        now
      });
      return { ok: true };
    }
    case "saveGroup":
    case "deleteGroup":
    case "saveRule":
    case "deleteRule":
    case "savePersistentTab":
    case "setDuplicateSettings":
    case "restoreSnapshot":
    case "deleteSnapshot":
      return {
        ok: false,
        code: "UNSUPPORTED_COMMAND",
        message: `${command.kind} is not available from menus`
      };
    default: {
      const _exhaustive: never = command;
      return {
        ok: false,
        code: "UNKNOWN_COMMAND",
        message: `unknown command ${(_exhaustive as UserCommand).kind}`
      };
    }
  }
}

export async function readPendingRuleDraft(
  session: SessionRepository
): Promise<PendingRuleDraft | undefined> {
  const runtime = await session.loadRuntime();
  const value = runtime[PENDING_RULE_DRAFT_KEY];
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as PendingRuleDraft).schemaVersion === 1 &&
    typeof (value as PendingRuleDraft).host === "string" &&
    typeof (value as PendingRuleDraft).url === "string"
  ) {
    return value as PendingRuleDraft;
  }
  return undefined;
}

export async function clearPendingRuleDraft(
  session: SessionRepository
): Promise<void> {
  await session.updateRuntime({ [PENDING_RULE_DRAFT_KEY]: undefined });
}

export function resolvePauseTarget(
  configuration: Configuration,
  managedGroupId: UUID | undefined,
  at: number
): {
  target: { kind: "global" } | { kind: "group"; id: UUID };
  duration: { kind: "restart" } | { kind: "resume" };
} {
  if (managedGroupId) {
    const group = configuration.groups.find(
      (candidate) => candidate.id === managedGroupId
    );
    if (group) {
      return {
        target: { kind: "group", id: group.id },
        duration: isPaused(group.pausedUntil, at)
          ? { kind: "resume" }
          : { kind: "restart" }
      };
    }
  }
  return {
    target: { kind: "global" },
    duration: isPaused(configuration.globalPausedUntil, at)
      ? { kind: "resume" }
      : { kind: "restart" }
  };
}

export function findManagedGroupForTab(
  tabId: number,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): UUID | undefined {
  const tab = findTab(inventory, tabId);
  if (!tab || tab.chromeGroupId < 0) return undefined;
  return associations.find(
    (association) =>
      association.chromeGroupId === tab.chromeGroupId &&
      association.chromeWindowId === tab.windowId
  )?.managedGroupId;
}

export function findPersistentTabId(
  configuration: Configuration,
  tabUrl: string | undefined,
  managedGroupId: UUID | undefined
): UUID | undefined {
  if (!tabUrl || !managedGroupId) return undefined;
  return configuration.persistentTabs.find(
    (tab) =>
      tab.managedGroupId === managedGroupId && tab.canonicalUrl === tabUrl
  )?.id;
}
