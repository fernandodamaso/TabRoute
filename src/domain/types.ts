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
  persistentTabs: never[];
  duplicateSettings: {
    globalPolicy: { kind: "allow" };
    globalExclusions: string[];
    trackingParameters: string[];
  };
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
      windowId: number;
      chromeGroupId?: number;
      ungrouped?: true;
    }
  | {
      kind: "managedGroupState";
      managedGroupId: UUID;
      windowId?: number;
      title?: string;
      color?: ChromeGroupColor;
      collapsed?: boolean;
    };

export interface OperationGuard {
  id: UUID;
  browserSessionId: BrowserSessionId;
  actionId: ActionId;
  operation: "assignTabsToManagedGroup" | "ungroupTabs";
  phase: "executing" | "settling";
  tabIds: number[];
  chromeGroupIds: number[];
  expectedEventKinds: GuardEventKind[];
  seenEventKinds: GuardEventKind[];
  postcondition?: GuardPostcondition;
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
  lastFocusedNormalWindowId?: number;
  associations: ChromeAssociation[];
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
  | { kind: "alarm"; name: string };

export interface RuntimeAssociations {
  associations: ChromeAssociation[];
}
