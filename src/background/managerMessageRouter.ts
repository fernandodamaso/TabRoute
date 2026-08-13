import {
  clearActivity,
  getAvailableUndo,
  listActivityEntries
} from "../activity/activityRepository";
import { executeUndo } from "../activity/executeUndo";
import type { ActionEngineDeps } from "../actions/executeActionPlan";
import { reconstructAssociations } from "../chrome/reconstructAssociations";
import { createManagedGroup, removeManagedGroup, updateManagedGroup } from "../domain/defaults";
import { validateConfiguration } from "../domain/schemas";
import type { Configuration, PersistentTab, UUID } from "../domain/types";
import {
  makePersistentDefinition,
  pinGroupDefinitions,
  removePersistent,
  reorderPersistentTabs,
  savePersistentTab,
  setRestorePersistentGroups,
  type PersistentTabDraft
} from "../persistence/persistentCommands";
import { collectLiveMemberUrls } from "../persistence/requirements";
import type { LocalRepository } from "../state/localRepository";
import type { SessionRepository } from "../state/sessionRepository";
import { validateRuleActions } from "../rules/ruleEngine";
import type {
  ActivityQuery,
  ManagerCommandPayload,
  ManagerMessage,
  ManagerResponse,
  ManagerSuccess,
  ManagerViewFixture,
  RuleDraft
} from "../ui/manager/types";

const view = {
  width: 520,
  height: 600,
  headerHeight: 52,
  navigationHeight: 42,
  defaultRoute: "groups",
  routes: ["groups", "rules", "activity", "settings"] as const
} satisfies ManagerSuccess["view"];

interface ManagerRepository { save(configuration: Configuration): Promise<void>; }
interface ManagerController {
  getConfiguration(): Configuration;
  replaceConfiguration(configuration: Configuration): Promise<void>;
}

interface ManagerInventoryPort {
  readInventory(): Promise<import("../domain/types").ChromeInventory>;
  loadPreferredWindowId(): Promise<number | undefined>;
  loadAssociations(
    configuration: Configuration,
    inventory: import("../domain/types").ChromeInventory
  ): Promise<readonly import("../domain/types").ChromeAssociation[]>;
}

export interface ActivityManagerPort {
  query(before: number | undefined, limit: number): Promise<ManagerViewFixture>;
  undo(undoId: UUID): Promise<void>;
  clear(): Promise<void>;
}

export function createActivityManagerPort(input: {
  local: LocalRepository;
  session: SessionRepository;
  actionDeps: () => ActionEngineDeps;
  getConfiguration: () => Configuration;
  now?: () => number;
}): ActivityManagerPort {
  const now = input.now ?? Date.now;
  return {
    async query(before, limit) {
      const runtime = await input.session.loadSession();
      const activity = await listActivityEntries(input.local, before, limit);
      const availableUndo = await getAvailableUndo(
        input.local,
        now(),
        runtime.browserSessionId
      );
      return {
        persistentTabsByGroup: {},
        activity,
        ...(availableUndo ? { availableUndo } : {})
      };
    },
    async undo(undoId) {
      await executeUndo({
        undoId,
        local: input.local,
        session: input.session,
        deps: input.actionDeps(),
        configuration: input.getConfiguration(),
        now: () => now()
      });
    },
    async clear() {
      await clearActivity(input.local);
    }
  };
}

export function createFixtureActivityManagerPort(input: {
  getViewFixture: () => ManagerViewFixture;
  setViewFixture: (next: ManagerViewFixture) => void;
}): ActivityManagerPort {
  return {
    async query(_before, _limit) {
      return input.getViewFixture();
    },
    async undo(_undoId) {
      return undefined;
    },
    async clear() {
      const current = input.getViewFixture();
      input.setViewFixture({
        ...current,
        activity: [],
        availableUndo: undefined
      });
    }
  };
}

function isUuid(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function success(
  configuration: Configuration,
  viewFixture?: ManagerViewFixture
): ManagerSuccess {
  return {
    ok: true,
    configuration,
    view,
    ...(viewFixture ? { viewFixture } : {})
  };
}

type ManagerFailureKind = "validation" | "reference" | "persistence";
function failure(kind: ManagerFailureKind, error: unknown): ManagerResponse {
  return { ok: false, error: { kind, message: error instanceof Error ? error.message : "manager command failed" } };
}

function domainFailure(error: unknown): ManagerResponse {
  const kind: ManagerFailureKind = error instanceof Error && /not found|missing/.test(error.message)
    ? "reference"
    : "validation";
  return failure(kind, error);
}

function ruleFromDraft(draft: RuleDraft, randomUuid: () => string, now: () => number) {
  const timestamp = now();
  return {
    ...draft,
    id: draft.id ?? (randomUuid() as UUID),
    createdAt: draft.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function updateRule(configuration: Configuration, ruleId: UUID, patch: Partial<Configuration["rules"][number]>, now: () => number) {
  if (!configuration.rules.some((rule) => rule.id === ruleId)) throw new Error("rule not found");
  const timestamp = now();
  return {
    ...configuration,
    rules: configuration.rules.map((rule) => rule.id === ruleId ? { ...rule, ...patch, updatedAt: timestamp } : rule),
    updatedAt: timestamp
  };
}

function applyCommand(
  current: Configuration,
  command: ManagerCommandPayload,
  randomUuid: () => string,
  now: () => number,
  inventory?: {
    inventory: import("../domain/types").ChromeInventory;
    associations: readonly import("../domain/types").ChromeAssociation[];
    preferredWindowId?: number;
  }
): Configuration {
  switch (command.kind) {
    case "updateGroup":
      if (!isUuid(command.groupId)) throw new Error("group id must be a UUID");
      return updateManagedGroup(current, command.groupId, command.patch, now);
    case "createGroup":
      return createManagedGroup(current, command.input, randomUuid, now);
    case "deleteGroup":
      if (!isUuid(command.groupId)) throw new Error("group id must be a UUID");
      return removeManagedGroup(current, command.groupId, now);
    case "saveRule": {
      if (command.rule.id !== undefined && !isUuid(command.rule.id)) throw new Error("rule id must be a UUID");
      validateRuleActions(command.rule.actions);
      const rule = ruleFromDraft(command.rule, randomUuid, now);
      const exists = current.rules.some((candidate) => candidate.id === rule.id);
      return { ...current, rules: exists ? current.rules.map((candidate) => candidate.id === rule.id ? rule : candidate) : [...current.rules, rule], updatedAt: now() };
    }
    case "duplicateRule": {
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      const source = current.rules.find((candidate) => candidate.id === command.ruleId);
      if (!source) throw new Error("rule not found");
      const timestamp = now();
      return { ...current, rules: [...current.rules, { ...source, id: randomUuid() as UUID, createdAt: timestamp, updatedAt: timestamp }], updatedAt: timestamp };
    }
    case "deleteRule":
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      if (!current.rules.some((candidate) => candidate.id === command.ruleId)) throw new Error("rule not found");
      return { ...current, rules: current.rules.filter((candidate) => candidate.id !== command.ruleId), updatedAt: now() };
    case "setRuleEnabled":
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      return updateRule(current, command.ruleId, { enabled: command.enabled }, now);
    case "setRulePaused":
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      return updateRule(current, command.ruleId, { pausedUntil: command.pausedUntil }, now);
    case "savePersistentTab": {
      const draft = command.draft as PersistentTabDraft;
      if (draft.id !== undefined && !isUuid(draft.id)) throw new Error("persistent tab id must be a UUID");
      if (!isUuid(draft.managedGroupId)) throw new Error("managed group id must be a UUID");
      return savePersistentTab(current, draft, now, randomUuid);
    }
    case "removePersistent":
      if (!isUuid(command.persistentTabId)) throw new Error("persistent tab id must be a UUID");
      return removePersistent(current, command.persistentTabId, now);
    case "reorderPersistentTabs":
      if (!isUuid(command.managedGroupId)) throw new Error("managed group id must be a UUID");
      if (!command.orderedIds.every((id) => isUuid(id))) throw new Error("ordered ids must be UUIDs");
      return reorderPersistentTabs(current, command.managedGroupId, command.orderedIds, now);
    case "pinGroup": {
      if (!isUuid(command.managedGroupId)) throw new Error("managed group id must be a UUID");
      if (!inventory) throw new Error("inventory unavailable");
      const memberUrls = collectLiveMemberUrls(
        command.managedGroupId,
        current,
        inventory.inventory,
        inventory.associations,
        inventory.preferredWindowId
      );
      return pinGroupDefinitions(
        current,
        command.managedGroupId,
        memberUrls,
        now,
        randomUuid
      );
    }
    case "makePersistent":
      if (!isUuid(command.managedGroupId)) throw new Error("managed group id must be a UUID");
      return makePersistentDefinition(current, command.managedGroupId, command.url, now, randomUuid);
    case "setRestorePersistentGroups":
      return setRestorePersistentGroups(current, command.enabled, now);
    case "undo":
    case "clearActivity":
      return current;
  }
}

export function createManagerMessageRouter(input: {
  repository: ManagerRepository;
  controller: ManagerController;
  activity: ActivityManagerPort;
  inventory?: ManagerInventoryPort;
  randomUuid?: () => string;
  now?: () => number;
}) {
  const randomUuid = input.randomUuid ?? (() => crypto.randomUUID());
  const now = input.now ?? Date.now;
  let mutationTail: Promise<void> = Promise.resolve();
  return {
    handle(message: ManagerMessage | ActivityQuery): Promise<ManagerResponse> {
      const run = async (): Promise<ManagerResponse> => {
        let current: Configuration;
        try {
          current = validateConfiguration(input.controller.getConfiguration());
          if (message.kind === "manager-query") return success(current);
          if (message.kind === "activity-query") {
            const viewFixture = await input.activity.query(message.before, message.limit);
            return success(current, viewFixture);
          }
        } catch (error) {
          return domainFailure(error);
        }

        if (message.kind === "manager-command") {
          if (message.command.kind === "undo") {
            if (!isUuid(message.command.undoId)) throw new Error("undo id must be a UUID");
            await input.activity.undo(message.command.undoId);
            const viewFixture = await input.activity.query(undefined, 50);
            return success(current, viewFixture);
          }
          if (message.command.kind === "clearActivity") {
            await input.activity.clear();
            const viewFixture = await input.activity.query(undefined, 50);
            return success(current, viewFixture);
          }
        }

        let next: Configuration;
        try {
          let inventoryContext:
            | {
                inventory: import("../domain/types").ChromeInventory;
                associations: readonly import("../domain/types").ChromeAssociation[];
                preferredWindowId?: number;
              }
            | undefined;
          const commandPayload = (message as Extract<ManagerMessage, { kind: "manager-command" }>).command;
          if (commandPayload.kind === "pinGroup") {
            if (!input.inventory) throw new Error("inventory unavailable");
            const chromeInventory = await input.inventory.readInventory();
            const associations = await input.inventory.loadAssociations(
              current,
              chromeInventory
            );
            inventoryContext = {
              inventory: chromeInventory,
              associations,
              preferredWindowId: await input.inventory.loadPreferredWindowId()
            };
          }
          next = validateConfiguration(
            applyCommand(current, commandPayload, randomUuid, now, inventoryContext)
          );
        } catch (error) {
          return domainFailure(error);
        }

        try {
          await input.repository.save(next);
        } catch (error) {
          return failure("persistence", error);
        }

        try {
          await input.controller.replaceConfiguration(next);
        } catch {
          // Persistence is authoritative. The concrete controller installs the
          // accepted configuration before reconciliation, so a later Chrome
          // reconciliation failure must not make a durable command retryable.
        }
        return success(next);
      };

      if (message.kind === "manager-query" || message.kind === "activity-query") return run();
      const queued = mutationTail.then(run, run);
      mutationTail = queued.then(() => undefined, () => undefined);
      return queued;
    }
  };
}
