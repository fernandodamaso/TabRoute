import type {
  DuplicateSettings,
  ManagedGroup,
  PersistentTab,
  SnapshotScope,
  UUID
} from "../domain/types";

export type PauseTarget =
  | { kind: "global" }
  | { kind: "group"; id: UUID }
  | { kind: "rule"; id: UUID };

export type PauseDuration =
  | { kind: "until"; timestamp: number }
  | { kind: "restart" }
  | { kind: "resume" };

export type ManagedGroupDraft = {
  id?: UUID;
  name: string;
  emoji?: string;
  color: ManagedGroup["color"];
  duplicatePolicy?: ManagedGroup["duplicatePolicy"];
};

export type RuleDraft = Omit<
  import("../domain/types").Rule,
  "schemaVersion" | "id" | "createdAt" | "updatedAt"
> & { id?: UUID };

export type PersistentTabDraft = Omit<
  PersistentTab,
  "schemaVersion" | "id" | "createdAt" | "updatedAt"
> & { id?: UUID };

export type UserCommand =
  | { kind: "openManager" }
  | { kind: "createRuleFromTab"; tabId: number }
  | { kind: "makePersistent"; tabId: number; managedGroupId: UUID }
  | { kind: "removePersistent"; persistentTabId: UUID }
  | { kind: "pinGroup"; managedGroupId: UUID }
  | { kind: "toggleAutomation" }
  | { kind: "moveToOther"; tabId: number }
  | { kind: "moveToGroup"; tabId: number; managedGroupId: UUID }
  | { kind: "setGroupCollapsed"; managedGroupId: UUID; collapsed: boolean }
  | { kind: "excludeFromDuplicates"; tabId: number }
  | { kind: "saveGroup"; draft: ManagedGroupDraft }
  | { kind: "deleteGroup"; managedGroupId: UUID }
  | { kind: "saveRule"; draft: RuleDraft }
  | { kind: "deleteRule"; ruleId: UUID }
  | { kind: "savePersistentTab"; draft: PersistentTabDraft }
  | { kind: "setDuplicateSettings"; settings: DuplicateSettings }
  | { kind: "setPause"; target: PauseTarget; duration: PauseDuration }
  | { kind: "saveSnapshot"; scope: SnapshotScope; name: string }
  | { kind: "restoreSnapshot"; snapshotId: UUID }
  | { kind: "deleteSnapshot"; snapshotId: UUID }
  | { kind: "undo"; undoId: UUID };

export type CommandResult =
  | { ok: true; actionId?: string; draftId?: UUID; degraded?: boolean }
  | { ok: false; code: string; message: string };
