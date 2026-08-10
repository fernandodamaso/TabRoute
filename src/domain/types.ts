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

export interface ChromeAssociation {
  managedGroupId: UUID;
  chromeGroupId: number;
  chromeWindowId: number;
  observedAt: number;
}

export interface RuntimeAssociations {
  associations: ChromeAssociation[];
}
