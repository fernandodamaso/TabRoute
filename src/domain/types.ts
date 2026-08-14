export type UUID = string & { readonly __brand: "UUID" };

export type ChromeGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export interface PersistentTab {
  schemaVersion: 1;
  id: UUID;
  managedGroupId: UUID;
  canonicalUrl: string;
  acceptedPatterns: string[];
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedGroup {
  schemaVersion: 1;
  id: UUID;
  name: string;
  emoji?: string;
  color: ChromeGroupColor;
  isFallback: boolean;
  enabled: boolean;
  isPersistent: boolean;
  defaultOrder: number;
  defaultCollapsed: boolean;
  duplicatePolicy?: DuplicatePolicy;
  pausedUntil?: number | "restart";
  createdAt: number;
  updatedAt: number;
}

export interface Configuration {
  schemaVersion: 1;
  fallbackGroupId: UUID;
  automationEnabled: boolean;
  globalPausedUntil?: number | "restart";
  groups: ManagedGroup[];
  rules: Rule[];
  persistentTabs: PersistentTab[];
  restorePersistentGroups?: boolean;
  duplicateSettings: DuplicateSettings;
  templates: never[];
  snapshotIntervalMinutes: number;
  activityLimit: 500;
  snapshotLimit: 50;
  undoTtlMs: 30000;
  createdAt: number;
  updatedAt: number;
}

export type DuplicatePolicy =
  | { kind: "allow" }
  | { kind: "exactUrl" }
  | { kind: "fragmentlessUrl" }
  | { kind: "domain" }
  | { kind: "urlAndTitle" }
  | { kind: "pattern"; pattern: string };

export interface DuplicateSettings {
  globalPolicy: DuplicatePolicy;
  globalExclusions: string[];
  trackingParameters: string[];
}

export type RuleAction =
  | { kind: "group" }
  | { kind: "ungroup" }
  | { kind: "makePersistent" }
  | { kind: "setDuplicatePolicy"; policy: DuplicatePolicy }
  | { kind: "setCollapsed"; collapsed: boolean };

export type CurrentPlacement =
  | { kind: "managed"; managedGroupId: UUID }
  | { kind: "unmanaged" }
  | { kind: "ungrouped" };

export type ConditionNode =
  | { kind: "all" | "any"; children: ConditionNode[] }
  | { kind: "url"; operator: "exact" | "pattern" | "regex"; value: string }
  | { kind: "host"; operator: "exact" | "suffix"; value: string }
  | { kind: "path"; operator: "exact" | "prefix"; value: string }
  | { kind: "title"; operator: "contains" | "exact" | "regex"; value: string }
  | { kind: "pinned"; value: boolean }
  | {
      kind: "openerUrl" | "openerHost";
      operator: "exact" | "pattern" | "suffix";
      value: string;
    }
  | { kind: "currentGroup"; placement: CurrentPlacement };

export interface Rule {
  schemaVersion: 1;
  id: UUID;
  targetGroupId: UUID;
  priority: number;
  positive: ConditionNode;
  negative: ConditionNode[];
  actions: RuleAction[];
  duplicatePolicy?: DuplicatePolicy;
  enabled: boolean;
  pausedUntil?: number | "restart";
  createdAt: number;
  updatedAt: number;
}

export interface WindowSnapshot {
  id: number;
  focused: boolean;
  incognito: boolean;
  type: "normal";
}

export interface ChromeTabSnapshot {
  id: number;
  windowId: number;
  index: number;
  chromeGroupId: number;
  url?: string;
  pendingUrl?: string;
  status?: "unloaded" | "loading" | "complete";
  title: string;
  pinned: boolean;
  active: boolean;
  incognito: false;
  lastAccessed: number;
  openerTabId?: number;
  openerUrl?: string;
}

export interface ChromeGroupSnapshot {
  id: number;
  windowId: number;
  title: string;
  color: ChromeGroupColor;
  collapsed: boolean;
  shared: boolean;
}

export interface ChromeInventory {
  windows: readonly WindowSnapshot[];
  tabs: readonly ChromeTabSnapshot[];
  groups: readonly ChromeGroupSnapshot[];
  capturedAt: number;
}

export interface TabSnapshot extends ChromeTabSnapshot {
  routing: { kind: "pending" } | { kind: "routable"; url: string };
}

export interface BrowserInventory extends Omit<ChromeInventory, "tabs"> {
  tabs: readonly TabSnapshot[];
}

export interface RecentlyClosedTab {
  sessionId?: string;
  url?: string;
  title: string;
  lastAccessed: number;
}

export interface WindowOwnershipDescriptor {
  memberUrls: string[];
  order: number;
  collapsed: boolean;
}

export interface TabSnapshotRecord {
  url: string;
  title: string;
  duplicateKey: string | null;
  duplicatePolicy?: DuplicatePolicy;
  order: number;
}

export interface SnapshotGroup {
  managedGroupId: UUID;
  name: string;
  emoji?: string;
  color: ChromeGroupColor;
  collapsed: boolean;
  order: number;
  tabs: TabSnapshotRecord[];
  ownership?: WindowOwnershipDescriptor;
}

export type SnapshotScope =
  { kind: "browser" } | { kind: "group"; managedGroupId: UUID };

export interface Snapshot {
  schemaVersion: 1;
  id: UUID;
  name: string;
  kind: "named" | "automatic" | "checkpoint";
  scope: SnapshotScope;
  groups: SnapshotGroup[];
  createdAt: number;
  updatedAt: number;
}

export interface ShutdownCheckpoint {
  schemaVersion: 1;
  snapshot: Snapshot;
  capturedAt: number;
  sourceActionId?: ActionId;
}

export interface ActivityEntry {
  schemaVersion: 1;
  id: UUID;
  action: string;
  result: "success" | "retry" | "degraded" | "failure";
  affectedManagedGroupIds: UUID[];
  affectedUrls: string[];
  actionId?: ActionId;
  source?: string;
  errorCode?: string;
  undoId?: UUID;
  createdAt: number;
}

export type UndoPlacement =
  | {
      kind: "managedGroup";
      managedGroupId: UUID;
      windowIdHint?: number;
      index: number;
    }
  | { kind: "ungrouped"; windowIdHint?: number; index: number }
  | {
      kind: "unmanagedGroup";
      chromeGroupIdHint: number;
      windowIdHint: number;
      index: number;
    };

export type UndoPayload =
  | {
      kind: "restorePlacement";
      tabId: number;
      expectedUrl: string;
      placement: UndoPlacement;
    }
  | {
      kind: "restoreClosedTab";
      sessionId?: string;
      url: string;
      title: string;
      placement: UndoPlacement;
    }
  | {
      kind: "restoreGroupPresentation";
      managedGroupId: UUID;
      patch: { title?: string; color?: ChromeGroupColor; collapsed?: boolean };
    };

export interface UndoRecord {
  schemaVersion: 1;
  id: UUID;
  actionId: ActionId;
  browserSessionId: BrowserSessionId;
  payloads: UndoPayload[];
  expiresAt: number;
  createdAt: number;
}

export interface StorageDiagnostics {
  syncBytes: number;
  syncQuotaBytes: 102400;
  syncLargestItemBytes: number;
  syncQuotaBytesPerItem: 8192;
  syncItemCount: number;
  syncMaxItems: 512;
  localBytes: number;
  localSoftBudgetBytes: 9437184;
  localQuotaBytes: 10485760;
  sessionBytes: number;
  sessionQuotaBytes: 10485760;
}

export type BrowserSessionId = string & {
  readonly __brand: "BrowserSessionId";
};
export type ActionId = string & { readonly __brand: "ActionId" };

export type GuardEventKind =
  | "tabCreated"
  | "tabUpdated"
  | "tabActivated"
  | "tabMoved"
  | "tabAttached"
  | "tabDetached"
  | "tabRemoved"
  | "tabReplaced"
  | "groupCreated"
  | "groupUpdated"
  | "groupMoved"
  | "groupRemoved";

export type GuardPostcondition =
  | {
      kind: "tabPlacement";
      tabIds: number[];
      windowId?: number;
      chromeGroupId?: number;
      grouped?: true;
      ungrouped?: true;
    }
  | {
      kind: "tabsPresent";
      tabIds: number[];
    }
  | {
      kind: "tabsAbsent";
      tabIds: number[];
    }
  | {
      kind: "managedGroupState";
      managedGroupId: UUID;
      chromeGroupId: number;
      windowId?: number;
      title?: string;
      color?: ChromeGroupColor;
      collapsed?: boolean;
    };

export interface OperationGuard {
  id: UUID;
  browserSessionId: BrowserSessionId;
  actionId: ActionId;
  operation:
    | "assignTabsToManagedGroup"
    | "ungroupTabs"
    | "createTab"
    | "restoreClosedTab"
    | "moveTabs"
    | "assignTabsToUnmanagedGroup"
    | "updateManagedGroup"
    | "moveManagedGroup"
    | "reorderTabs"
    | "focusTab"
    | "closeDuplicate"
    | "removeTabs";
  phase: "executing" | "settling";
  tabIds: number[];
  chromeGroupIds: number[];
  expectedEventKinds: GuardEventKind[];
  seenEventKinds: GuardEventKind[];
  postcondition?: GuardPostcondition;
  pendingTab?: { url: string; windowId?: number };
  startedAt: number;
  verifiedAt?: number;
  settleAfter?: number;
  expiresAt: number;
}

export type ManualPlacement =
  | { kind: "managedGroup"; managedGroupId: UUID }
  | { kind: "ungrouped" }
  | { kind: "leaveWherePlaced" };

export interface ManualOverride {
  tabId: number;
  placement: ManualPlacement;
  createdAt: number;
}

export interface TabObservation {
  tabId: number;
  firstObservedAt: number;
  firstObservedOrdinal: number;
  lastObservedUrl: string;
}

export interface PendingGroupRemoval {
  managedGroupId: UUID;
  removedChromeGroupId: number;
  oldWindowId: number;
  memberTabIds: number[];
  memberUrls: string[];
  renderedTitle: string;
  startedAt: number;
  settleAfter: number;
}

export interface PendingWindowClosure {
  windowId: number;
  managedGroupIds: UUID[];
  tabIds: number[];
  startedAt: number;
}

export interface StartupRestoreState {
  startedAt: number;
  deadlineAt: number;
  lastRelevantEventAt: number;
  consecutiveQuietScans: 0 | 1 | 2;
}

export interface ChromeAssociation {
  managedGroupId: UUID;
  chromeGroupId: number;
  chromeWindowId: number;
  observedTitle: string;
  observedMemberUrls: string[];
  observedAt: number;
}

export interface RuntimeSession {
  schemaVersion: 1;
  browserSessionId: BrowserSessionId;
  nextObservationOrdinal: number;
  tabObservations: TabObservation[];
  manualOverrides: Record<string, ManualOverride>;
  intentionallyClosedGroupIds: UUID[];
  operationGuards: OperationGuard[];
  pendingGroupRemovals: PendingGroupRemoval[];
  pendingWindowClosures: PendingWindowClosure[];
  lastFocusedNormalWindowId?: number;
  associations: ChromeAssociation[];
  startupRestore?: StartupRestoreState;
}

export type ChromeEventHint =
  | { kind: "tabCreated"; tabId: number }
  | {
      kind: "tabUpdated";
      tabId: number;
      urlChanged: boolean;
      groupChanged: boolean;
      pinnedChanged: boolean;
    }
  | { kind: "tabActivated"; tabId: number; windowId: number }
  | {
      kind: "tabMoved";
      tabId: number;
      windowId: number;
      fromIndex: number;
      toIndex: number;
    }
  | {
      kind: "tabAttached";
      tabId: number;
      newWindowId: number;
      newPosition: number;
    }
  | {
      kind: "tabDetached";
      tabId: number;
      oldWindowId: number;
      oldPosition: number;
    }
  | {
      kind: "tabRemoved";
      tabId: number;
      windowId: number;
      isWindowClosing: boolean;
    }
  | { kind: "tabReplaced"; addedTabId: number; removedTabId: number }
  | {
      kind: "groupCreated" | "groupUpdated" | "groupMoved" | "groupRemoved";
      group: ChromeGroupSnapshot;
    }
  | {
      kind: "windowFocusChanged";
      focus: { kind: "none" } | { kind: "normal"; windowId: number };
    }
  | { kind: "windowRemoved"; windowId: number }
  | { kind: "startup" }
  | { kind: "alarm"; name: string };

export interface RuntimeAssociations {
  associations: ChromeAssociation[];
}
