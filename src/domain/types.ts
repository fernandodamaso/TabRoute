export type UUID = string & { readonly __brand: "UUID" };

export type ChromeGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export interface ManagedGroup {
  schemaVersion: 1;
  id: UUID;
  name: string;
  emoji?: string;
  color: ChromeGroupColor;
  isFallback: boolean;
  isPersistent: boolean;
  defaultOrder: number;
  defaultCollapsed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Configuration {
  schemaVersion: 1;
  fallbackGroupId: UUID;
  automationEnabled: boolean;
  globalPausedUntil?: number | "restart";
  groups: ManagedGroup[];
  rules: never[];
  persistentTabs: never[];
  duplicateSettings: { globalPolicy: { kind: "allow" }; globalExclusions: string[]; trackingParameters: string[] };
  templates: never[];
  snapshotIntervalMinutes: number;
  activityLimit: 500;
  snapshotLimit: 50;
  undoTtlMs: 30000;
  createdAt: number;
  updatedAt: number;
}

export interface WindowSnapshot { id: number; focused: boolean; incognito: boolean; type: "normal"; }

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

export interface RuntimeAssociations { associations: ChromeAssociation[]; }
