import {
  clearActivity,
  getAvailableUndo,
  listActivityEntries
} from "../activity/activityRepository";
import { executeUndo } from "../activity/executeUndo";
import type { ActionEngineDeps } from "../actions/executeActionPlan";
import {
  createManagedGroup,
  removeManagedGroup,
  updateManagedGroup
} from "../domain/defaults";
import { validateConfiguration } from "../domain/schemas";
import type { Configuration, UUID, ChromeInventory } from "../domain/types";
import {
  setAutomationEnabled,
  setDuplicateSettings,
  setRestorePersistentGroups,
  setSnapshotIntervalMinutes
} from "../settings/settingsCommands";
import {
  exportPortableConfiguration,
  parsePortableConfigurationImport
} from "../settings/portableConfiguration";
import {
  buildDiagnosticsWarnings,
  type DiagnosticsViewState
} from "../settings/diagnosticsState";
import {
  makePersistentDefinition,
  pinGroupDefinitions,
  removePersistent,
  reorderPersistentTabs,
  savePersistentTab,
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
  RuleDraft,
  SnapshotsQuery,
  DiagnosticsQuery
} from "../ui/manager/types";
import {
  buildSnapshotContext,
  deleteSnapshotRecord,
  listUserSnapshots,
  renameSnapshotRecord,
  restoreSnapshotFromRecord,
  saveNamedSnapshot,
  updateSnapshotFromInventory
} from "../snapshots/snapshotService";
import { observeInventory } from "../duplicates/observations";

const view = {
  width: 520,
  height: 600,
  headerHeight: 52,
  navigationHeight: 42,
  defaultRoute: "groups",
  routes: ["groups", "rules", "activity", "settings"] as const
} satisfies ManagerSuccess["view"];

interface ManagerRepository {
  save(configuration: Configuration): Promise<void>;
}
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

export interface SnapshotManagerPort {
  query(): Promise<ManagerViewFixture>;
  save(
    name: string,
    scope: import("../domain/types").SnapshotScope
  ): Promise<ManagerResponse>;
  restore(snapshotId: UUID): Promise<ManagerResponse>;
  update(snapshotId: UUID): Promise<ManagerResponse>;
  rename(snapshotId: UUID, name: string): Promise<ManagerResponse>;
  delete(snapshotId: UUID): Promise<ManagerResponse>;
}

export function createSnapshotManagerPort(input: {
  local: LocalRepository;
  session: SessionRepository;
  actionDeps: () => ActionEngineDeps;
  getConfiguration: () => Configuration;
  readInventory: () => Promise<import("../domain/types").ChromeInventory>;
  now?: () => number;
}): SnapshotManagerPort {
  const now = input.now ?? Date.now;
  async function viewFixture(): Promise<ManagerViewFixture> {
    const snapshots = listUserSnapshots(await input.local.listSnapshots());
    return { persistentTabsByGroup: {}, snapshots };
  }
  async function captureContext(inventory?: ChromeInventory) {
    return buildSnapshotContext({
      configuration: input.getConfiguration(),
      local: input.local,
      inventory
    });
  }
  return {
    async query() {
      return viewFixture();
    },
    async save(name, scope) {
      const raw = await input.readInventory();
      const session = await input.session.loadSession();
      const { inventory } = observeInventory(raw, session);
      const result = await saveNamedSnapshot({
        local: input.local,
        name,
        scope,
        inventory,
        context: await captureContext(raw),
        now: () => now()
      });
      if (!result.ok) {
        return {
          ok: false,
          error: {
            kind: "persistence",
            code: result.code,
            message: result.message ?? result.code
          }
        };
      }
      return {
        ok: true,
        configuration: input.getConfiguration(),
        view: success(input.getConfiguration()).view,
        viewFixture: await viewFixture()
      };
    },
    async restore(snapshotId) {
      const result = await restoreSnapshotFromRecord({
        local: input.local,
        session: input.session,
        snapshotId,
        actionDeps: input.actionDeps(),
        now: () => now()
      });
      if (!result.ok) {
        return {
          ok: false,
          error: {
            kind:
              result.code === "SNAPSHOT_GROUP_MISSING"
                ? "reference"
                : "persistence",
            code: result.code,
            message: result.message ?? result.code
          }
        };
      }
      return {
        ok: true,
        configuration: input.getConfiguration(),
        view: success(input.getConfiguration()).view,
        viewFixture: await viewFixture()
      };
    },
    async update(snapshotId) {
      const raw = await input.readInventory();
      const session = await input.session.loadSession();
      const { inventory } = observeInventory(raw, session);
      const result = await updateSnapshotFromInventory({
        local: input.local,
        snapshotId,
        inventory,
        context: await captureContext(raw),
        now: () => now()
      });
      if (!result.ok) {
        return {
          ok: false,
          error: {
            kind: "persistence",
            code: result.code,
            message: result.message ?? result.code
          }
        };
      }
      return {
        ok: true,
        configuration: input.getConfiguration(),
        view: success(input.getConfiguration()).view,
        viewFixture: await viewFixture()
      };
    },
    async rename(snapshotId, name) {
      const result = await renameSnapshotRecord({
        local: input.local,
        snapshotId,
        name,
        now: () => now()
      });
      if (!result.ok) {
        return {
          ok: false,
          error: {
            kind: "validation",
            code: result.code,
            message: result.message ?? result.code
          }
        };
      }
      return {
        ok: true,
        configuration: input.getConfiguration(),
        view: success(input.getConfiguration()).view,
        viewFixture: await viewFixture()
      };
    },
    async delete(snapshotId) {
      const result = await deleteSnapshotRecord({
        local: input.local,
        snapshotId
      });
      if (!result.ok) {
        return {
          ok: false,
          error: {
            kind: "reference",
            code: result.code,
            message: result.message ?? result.code
          }
        };
      }
      return {
        ok: true,
        configuration: input.getConfiguration(),
        view: success(input.getConfiguration()).view,
        viewFixture: await viewFixture()
      };
    }
  };
}

export function createFixtureSnapshotManagerPort(input: {
  getViewFixture: () => ManagerViewFixture;
  setViewFixture: (next: ManagerViewFixture) => void;
  getConfiguration: () => Configuration;
}): SnapshotManagerPort {
  const successResponse = async (): Promise<ManagerResponse> => ({
    ok: true,
    configuration: input.getConfiguration(),
    view,
    viewFixture: input.getViewFixture()
  });
  return {
    async query() {
      return input.getViewFixture();
    },
    async save(name, scope) {
      const current = input.getViewFixture();
      const snapshots = [...(current.snapshots ?? [])];
      const snapshot = {
        schemaVersion: 1 as const,
        id: crypto.randomUUID() as UUID,
        name,
        kind: "named" as const,
        scope,
        groups: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      input.setViewFixture({ ...current, snapshots: [snapshot, ...snapshots] });
      return successResponse();
    },
    async restore(_snapshotId) {
      return successResponse();
    },
    async update(_snapshotId) {
      return successResponse();
    },
    async rename(snapshotId, name) {
      const current = input.getViewFixture();
      input.setViewFixture({
        ...current,
        snapshots: (current.snapshots ?? []).map((snapshot) =>
          snapshot.id === snapshotId ? { ...snapshot, name } : snapshot
        )
      });
      return successResponse();
    },
    async delete(snapshotId) {
      const current = input.getViewFixture();
      input.setViewFixture({
        ...current,
        snapshots: (current.snapshots ?? []).filter(
          (snapshot) => snapshot.id !== snapshotId
        )
      });
      return successResponse();
    }
  };
}

export interface DiagnosticsManagerPort {
  query(): Promise<ManagerViewFixture>;
  recheck(): Promise<ManagerViewFixture>;
  retryPendingSync(): Promise<ManagerViewFixture>;
  reconcileAll(): Promise<void>;
  exportActivityLog(): Promise<ManagerViewFixture>;
}

export function createDiagnosticsManagerPort(input: {
  local: LocalRepository;
  session: SessionRepository;
  getConfiguration: () => Configuration;
  applySyncChange?: () => Promise<{ kind: string; reason?: string }>;
  reconcileAll?: () => Promise<void>;
  offline?: () => boolean;
}): DiagnosticsManagerPort {
  async function buildFixture(): Promise<ManagerViewFixture> {
    const runtime = await input.session.loadRuntime();
    const storage = await input.local.getStorageDiagnostics();
    const pendingSyncRevision =
      typeof runtime.pendingSyncRevision === "string"
        ? runtime.pendingSyncRevision
        : undefined;
    const syncInvalid = runtime.lastSyncInvalid === true;
    const diagnostics: DiagnosticsViewState = {
      storage,
      warnings: buildDiagnosticsWarnings({
        storage,
        pendingSyncRevision,
        syncInvalid,
        offline: input.offline?.() ?? false
      })
    };
    return { persistentTabsByGroup: {}, diagnostics };
  }
  return {
    async query() {
      return buildFixture();
    },
    async recheck() {
      return buildFixture();
    },
    async retryPendingSync() {
      if (input.applySyncChange) await input.applySyncChange();
      return buildFixture();
    },
    async reconcileAll() {
      await input.reconcileAll?.();
    },
    async exportActivityLog() {
      const activity = await listActivityEntries(input.local, undefined, 500);
      return {
        persistentTabsByGroup: {},
        ...((await buildFixture()).diagnostics
          ? { diagnostics: (await buildFixture()).diagnostics }
          : {}),
        activityLogExport: JSON.stringify(activity, null, 2)
      };
    }
  };
}

export function createFixtureDiagnosticsManagerPort(input: {
  getViewFixture: () => ManagerViewFixture;
  setViewFixture: (next: ManagerViewFixture) => void;
  getConfiguration: () => Configuration;
  local?: LocalRepository;
}): DiagnosticsManagerPort {
  const fallbackDiagnostics = (): DiagnosticsViewState => ({
    storage: {
      syncBytes: 0,
      syncQuotaBytes: 102400,
      syncLargestItemBytes: 0,
      syncQuotaBytesPerItem: 8192,
      syncItemCount: 0,
      syncMaxItems: 512,
      localBytes: 0,
      localSoftBudgetBytes: 9437184,
      localQuotaBytes: 10485760,
      sessionBytes: 0,
      sessionQuotaBytes: 10485760
    },
    warnings: []
  });
  return {
    async query() {
      const current = input.getViewFixture();
      return {
        ...current,
        diagnostics: current.diagnostics ?? fallbackDiagnostics()
      };
    },
    async recheck() {
      return this.query();
    },
    async retryPendingSync() {
      const current = input.getViewFixture();
      const diagnostics = current.diagnostics ?? fallbackDiagnostics();
      input.setViewFixture({
        ...current,
        diagnostics: {
          ...diagnostics,
          warnings: diagnostics.warnings.filter(
            (warning) => warning !== "SYNC_INCOMPLETE"
          )
        }
      });
      return input.getViewFixture();
    },
    async reconcileAll() {
      return undefined;
    },
    async exportActivityLog() {
      const current = input.getViewFixture();
      const activity = current.activity ?? [];
      return {
        ...current,
        diagnostics: current.diagnostics ?? fallbackDiagnostics(),
        activityLogExport: JSON.stringify(activity, null, 2)
      };
    }
  };
}

function isUuid(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
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
  return {
    ok: false,
    error: {
      kind,
      message: error instanceof Error ? error.message : "manager command failed"
    }
  };
}

function domainFailure(error: unknown): ManagerResponse {
  const kind: ManagerFailureKind =
    error instanceof Error &&
    /not found|missing|unavailable/.test(error.message)
      ? "reference"
      : "validation";
  return failure(kind, error);
}

function ruleFromDraft(
  draft: RuleDraft,
  randomUuid: () => string,
  now: () => number
) {
  const timestamp = now();
  return {
    ...draft,
    id: draft.id ?? (randomUuid() as UUID),
    createdAt: draft.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function updateRule(
  configuration: Configuration,
  ruleId: UUID,
  patch: Partial<Configuration["rules"][number]>,
  now: () => number
) {
  if (!configuration.rules.some((rule) => rule.id === ruleId))
    throw new Error("rule not found");
  const timestamp = now();
  return {
    ...configuration,
    rules: configuration.rules.map((rule) =>
      rule.id === ruleId ? { ...rule, ...patch, updatedAt: timestamp } : rule
    ),
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
      if (command.rule.id !== undefined && !isUuid(command.rule.id))
        throw new Error("rule id must be a UUID");
      validateRuleActions(command.rule.actions);
      const rule = ruleFromDraft(command.rule, randomUuid, now);
      const exists = current.rules.some(
        (candidate) => candidate.id === rule.id
      );
      return {
        ...current,
        rules: exists
          ? current.rules.map((candidate) =>
              candidate.id === rule.id ? rule : candidate
            )
          : [...current.rules, rule],
        updatedAt: now()
      };
    }
    case "duplicateRule": {
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      const source = current.rules.find(
        (candidate) => candidate.id === command.ruleId
      );
      if (!source) throw new Error("rule not found");
      const timestamp = now();
      return {
        ...current,
        rules: [
          ...current.rules,
          {
            ...source,
            id: randomUuid() as UUID,
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ],
        updatedAt: timestamp
      };
    }
    case "deleteRule":
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      if (!current.rules.some((candidate) => candidate.id === command.ruleId))
        throw new Error("rule not found");
      return {
        ...current,
        rules: current.rules.filter(
          (candidate) => candidate.id !== command.ruleId
        ),
        updatedAt: now()
      };
    case "setRuleEnabled":
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      return updateRule(
        current,
        command.ruleId,
        { enabled: command.enabled },
        now
      );
    case "setRulePaused":
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      return updateRule(
        current,
        command.ruleId,
        { pausedUntil: command.pausedUntil },
        now
      );
    case "savePersistentTab": {
      const draft = command.draft as PersistentTabDraft;
      if (draft.id !== undefined && !isUuid(draft.id))
        throw new Error("persistent tab id must be a UUID");
      if (!isUuid(draft.managedGroupId))
        throw new Error("managed group id must be a UUID");
      return savePersistentTab(current, draft, now, randomUuid);
    }
    case "removePersistent":
      if (!isUuid(command.persistentTabId))
        throw new Error("persistent tab id must be a UUID");
      return removePersistent(current, command.persistentTabId, now);
    case "reorderPersistentTabs":
      if (!isUuid(command.managedGroupId))
        throw new Error("managed group id must be a UUID");
      if (!command.orderedIds.every((id) => isUuid(id)))
        throw new Error("ordered ids must be UUIDs");
      return reorderPersistentTabs(
        current,
        command.managedGroupId,
        command.orderedIds,
        now
      );
    case "pinGroup": {
      if (!isUuid(command.managedGroupId))
        throw new Error("managed group id must be a UUID");
      if (!inventory) throw new Error("inventory unavailable");
      const memberUrls = collectLiveMemberUrls(
        command.managedGroupId,
        current,
        inventory.inventory,
        inventory.associations,
        inventory.preferredWindowId
      );
      if (memberUrls.kind === "unavailable")
        throw new Error("live managed group unavailable");
      return pinGroupDefinitions(
        current,
        command.managedGroupId,
        memberUrls.urls,
        now,
        randomUuid
      );
    }
    case "makePersistent":
      if (!isUuid(command.managedGroupId))
        throw new Error("managed group id must be a UUID");
      return makePersistentDefinition(
        current,
        command.managedGroupId,
        command.url,
        now,
        randomUuid
      );
    case "setRestorePersistentGroups":
      return setRestorePersistentGroups(current, command.enabled, now);
    case "setAutomationEnabled":
      return setAutomationEnabled(current, command.enabled, now);
    case "setDuplicateSettings":
      return setDuplicateSettings(current, command.settings, now);
    case "setSnapshotIntervalMinutes":
      return setSnapshotIntervalMinutes(current, command.minutes, now);
    case "importConfiguration": {
      const parsed = parsePortableConfigurationImport(JSON.parse(command.json));
      if (!parsed.ok) throw new Error(parsed.message);
      return parsed.configuration;
    }
    case "exportConfiguration":
    case "diagnosticsRecheck":
    case "retryPendingSync":
    case "reconcileAll":
    case "exportActivityLog":
    case "saveSnapshot":
    case "restoreSnapshot":
    case "updateSnapshot":
    case "renameSnapshot":
    case "deleteSnapshot":
    case "undo":
    case "clearActivity":
      return current;
  }
}

export function createManagerMessageRouter(input: {
  repository: ManagerRepository;
  controller: ManagerController;
  activity: ActivityManagerPort;
  snapshots: SnapshotManagerPort;
  diagnostics: DiagnosticsManagerPort;
  inventory?: ManagerInventoryPort;
  consumePendingRuleDraft?: () => Promise<
    { host: string; url: string } | undefined
  >;
  randomUuid?: () => string;
  now?: () => number;
}) {
  const randomUuid = input.randomUuid ?? (() => crypto.randomUUID());
  const now = input.now ?? Date.now;
  let mutationTail: Promise<void> = Promise.resolve();
  return {
    handle(
      message:
        ManagerMessage | ActivityQuery | SnapshotsQuery | DiagnosticsQuery
    ): Promise<ManagerResponse> {
      const run = async (): Promise<ManagerResponse> => {
        let current: Configuration;
        try {
          current = validateConfiguration(input.controller.getConfiguration());
          if (message.kind === "manager-query") {
            const pendingRuleDraft = await input.consumePendingRuleDraft?.();
            return success(
              current,
              pendingRuleDraft
                ? { persistentTabsByGroup: {}, pendingRuleDraft }
                : undefined
            );
          }
          if (message.kind === "activity-query") {
            const viewFixture = await input.activity.query(
              message.before,
              message.limit
            );
            return success(current, viewFixture);
          }
          if (message.kind === "snapshots-query") {
            const viewFixture = await input.snapshots.query();
            return success(current, viewFixture);
          }
          if (message.kind === "diagnostics-query") {
            const viewFixture = await input.diagnostics.query();
            return success(current, viewFixture);
          }
        } catch (error) {
          return domainFailure(error);
        }

        if (message.kind === "manager-command") {
          if (message.command.kind === "undo") {
            if (!isUuid(message.command.undoId))
              throw new Error("undo id must be a UUID");
            await input.activity.undo(message.command.undoId);
            const viewFixture = await input.activity.query(undefined, 50);
            return success(current, viewFixture);
          }
          if (message.command.kind === "clearActivity") {
            await input.activity.clear();
            const viewFixture = await input.activity.query(undefined, 50);
            return success(current, viewFixture);
          }
          if (message.command.kind === "saveSnapshot") {
            return input.snapshots.save(
              message.command.name,
              message.command.scope
            );
          }
          if (message.command.kind === "restoreSnapshot") {
            if (!isUuid(message.command.snapshotId))
              throw new Error("snapshot id must be a UUID");
            return input.snapshots.restore(message.command.snapshotId);
          }
          if (message.command.kind === "updateSnapshot") {
            if (!isUuid(message.command.snapshotId))
              throw new Error("snapshot id must be a UUID");
            return input.snapshots.update(message.command.snapshotId);
          }
          if (message.command.kind === "renameSnapshot") {
            if (!isUuid(message.command.snapshotId))
              throw new Error("snapshot id must be a UUID");
            return input.snapshots.rename(
              message.command.snapshotId,
              message.command.name
            );
          }
          if (message.command.kind === "deleteSnapshot") {
            if (!isUuid(message.command.snapshotId))
              throw new Error("snapshot id must be a UUID");
            return input.snapshots.delete(message.command.snapshotId);
          }
          if (message.command.kind === "diagnosticsRecheck") {
            const viewFixture = await input.diagnostics.recheck();
            return success(current, viewFixture);
          }
          if (message.command.kind === "retryPendingSync") {
            const viewFixture = await input.diagnostics.retryPendingSync();
            return success(input.controller.getConfiguration(), viewFixture);
          }
          if (message.command.kind === "reconcileAll") {
            await input.diagnostics.reconcileAll();
            const viewFixture = await input.diagnostics.query();
            return success(current, viewFixture);
          }
          if (message.command.kind === "exportActivityLog") {
            const viewFixture = await input.diagnostics.exportActivityLog();
            return success(current, viewFixture);
          }
          if (message.command.kind === "exportConfiguration") {
            return success(current, {
              persistentTabsByGroup: {},
              activityLogExport: exportPortableConfiguration(current)
            });
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
          const commandPayload = (
            message as Extract<ManagerMessage, { kind: "manager-command" }>
          ).command;
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
            applyCommand(
              current,
              commandPayload,
              randomUuid,
              now,
              inventoryContext
            )
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

      if (
        message.kind === "manager-query" ||
        message.kind === "activity-query" ||
        message.kind === "snapshots-query" ||
        message.kind === "diagnostics-query"
      )
        return run();
      const queued = mutationTail.then(run, run);
      mutationTail = queued.then(
        () => undefined,
        () => undefined
      );
      return queued;
    }
  };
}
