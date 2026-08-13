import type { Configuration, ManagedGroup, Rule, UUID } from "../../domain/types";

export type ManagerRoute = "groups" | "rules" | "activity" | "settings";

export interface ManagerViewMetadata {
  width: 520;
  height: 600;
  headerHeight: 52;
  navigationHeight: 42;
  defaultRoute: "groups";
  routes: readonly ManagerRoute[];
}

import type { ActivityEntry, Snapshot, UndoRecord } from "../../domain/types";
import type { DiagnosticsViewState } from "../../settings/diagnosticsState";

export type ManagerQuery = { kind: "manager-query"; };
export type ActivityQuery = { kind: "activity-query"; before?: number; limit: number };
export type SnapshotsQuery = { kind: "snapshots-query" };
export type DiagnosticsQuery = { kind: "diagnostics-query" };

export type ManagedGroupPatch = Partial<Pick<ManagedGroup,
  "name" | "emoji" | "color" | "enabled" | "isPersistent" |
  "defaultOrder" | "defaultCollapsed" | "pausedUntil"
>>;

export type RuleDraft = Omit<Rule, "id" | "createdAt" | "updatedAt"> & {
  id?: UUID;
  createdAt?: number;
  updatedAt?: number;
};

export type ManagerCommandPayload =
  | { kind: "updateGroup"; groupId: UUID; patch: ManagedGroupPatch }
  | { kind: "createGroup"; input: { name: string; color: ManagedGroup["color"]; emoji?: string; isPersistent?: boolean; defaultCollapsed?: boolean } }
  | { kind: "deleteGroup"; groupId: UUID }
  | { kind: "saveRule"; rule: RuleDraft }
  | { kind: "duplicateRule"; ruleId: UUID }
  | { kind: "deleteRule"; ruleId: UUID }
  | { kind: "setRuleEnabled"; ruleId: UUID; enabled: boolean }
  | { kind: "setRulePaused"; ruleId: UUID; pausedUntil?: number | "restart" }
  | { kind: "undo"; undoId: UUID }
  | { kind: "clearActivity" }
  | { kind: "savePersistentTab"; draft: PersistentTabDraft }
  | { kind: "removePersistent"; persistentTabId: UUID }
  | { kind: "reorderPersistentTabs"; managedGroupId: UUID; orderedIds: readonly UUID[] }
  | { kind: "pinGroup"; managedGroupId: UUID }
  | { kind: "makePersistent"; managedGroupId: UUID; url: string }
  | { kind: "setRestorePersistentGroups"; enabled: boolean }
  | { kind: "saveSnapshot"; name: string; scope: import("../../domain/types").SnapshotScope }
  | { kind: "restoreSnapshot"; snapshotId: UUID }
  | { kind: "updateSnapshot"; snapshotId: UUID }
  | { kind: "renameSnapshot"; snapshotId: UUID; name: string }
  | { kind: "deleteSnapshot"; snapshotId: UUID }
  | { kind: "setAutomationEnabled"; enabled: boolean }
  | { kind: "setDuplicateSettings"; settings: import("../../domain/types").DuplicateSettings }
  | { kind: "setSnapshotIntervalMinutes"; minutes: number }
  | { kind: "importConfiguration"; json: string }
  | { kind: "exportConfiguration" }
  | { kind: "diagnosticsRecheck" }
  | { kind: "retryPendingSync" }
  | { kind: "reconcileAll" }
  | { kind: "exportActivityLog" };

export type PersistentTabDraft = Omit<
  import("../../domain/types").PersistentTab,
  "schemaVersion" | "id" | "createdAt" | "updatedAt"
> & { id?: UUID };

export interface ManagerCommand {
  kind: "manager-command";
  command: ManagerCommandPayload;
}

export type ManagerMessage =
  | ManagerQuery
  | ActivityQuery
  | SnapshotsQuery
  | DiagnosticsQuery
  | ManagerCommand;

export type ManagerDeepLink =
  | "none"
  | "new-rule"
  | "snapshots"
  | "diagnostics"
  | { kind: "edit-rule" | "confirm-delete"; ruleId: UUID };

export interface PersistentTabsViewFixture {
  state: "loading" | "empty" | "populated" | "disabled" | "error";
  tabs: readonly string[];
  persistentTabRecords?: readonly import("../../domain/types").PersistentTab[];
}

export interface ManagerViewFixture {
  persistentTabsByGroup: Readonly<Record<UUID, PersistentTabsViewFixture>>;
  activity?: readonly ActivityEntry[];
  availableUndo?: UndoRecord;
  snapshots?: readonly Snapshot[];
  diagnostics?: DiagnosticsViewState;
  activityLogExport?: string;
}

export type SettingsPanel = "root" | "snapshots" | "diagnostics";

export interface ManagerSuccess {
  ok: true;
  configuration: Configuration;
  view: ManagerViewMetadata;
  viewFixture?: ManagerViewFixture;
}

export interface ManagerFailure {
  ok: false;
  error: {
    kind: "validation" | "reference" | "persistence" | "offline" | "transport";
    message: string;
    code?: string;
    field?: string;
  };
}

export type ManagerResponse = ManagerSuccess | ManagerFailure;

export interface ManagerTransport {
  request(message: ManagerMessage): Promise<ManagerResponse>;
}

export interface ManagerAppProps {
  surface?: "popup" | "options";
  transport?: ManagerTransport;
  initialRoute?: ManagerRoute;
  initialDeepLink?: ManagerDeepLink;
}

type FixtureRequestRecordBase = {
  recordType: "request";
  mode: "fixture";
  requestId: string;
  sequence: number;
  scenarioId: string;
  message: ManagerMessage;
  startedAt: number;
  latencyMs: number;
};

type RealRequestRecordBase = {
  recordType: "request";
  mode: "real";
  requestId: string;
  sequence: number;
  workerGeneration?: number;
  message: ManagerMessage;
  startedAt: number;
  latencyMs: number;
};

type PendingRequestRecord = {
  state: "pending";
};

type ResolvedRequestRecord = {
  state: "resolved";
  endedAt: number;
  response: ManagerResponse;
};

type RejectedRequestRecord = {
  state: "rejected";
  endedAt: number;
  error: ManagerFailure["error"];
};

export type ManagerTransportRecord =
  | (FixtureRequestRecordBase & PendingRequestRecord)
  | (FixtureRequestRecordBase & ResolvedRequestRecord)
  | (FixtureRequestRecordBase & RejectedRequestRecord)
  | (RealRequestRecordBase & PendingRequestRecord)
  | (RealRequestRecordBase & ResolvedRequestRecord)
  | (RealRequestRecordBase & RejectedRequestRecord)
  | {
      recordType: "event";
      mode: "fixture" | "real";
      source: "page" | "worker" | "transport";
      at: number;
      name: string;
      details: Record<string, string | number | boolean>;
    };

export type FixtureCommandRecord = Extract<
  ManagerTransportRecord,
  { recordType: "request"; mode: "fixture" }
>;
