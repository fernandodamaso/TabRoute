export const SYNC_KEYS = {
  configurationHead: "config:v1:head",
  revisionPrefix: "config:v1:revision:"
} as const;

export const STORAGE_KEYS = {
  legacyConfiguration: "config:v1",
  localConfigurationShadow: "config-shadow:v1",
  localSnapshots: "snapshots:v1",
  localShutdownCheckpoint: "shutdown-latest:v1",
  localActivity: "activity:v1",
  localUndo: "undo:v1",
  localWindowOwnership: "window-ownership:v1",
  sessionRuntime: "runtime:v1"
} as const;

export const SYNC_LIMITS = {
  maxItemBytes: 7600,
  hardItemBytes: 8192,
  maxTotalBytes: 102400,
  maxItems: 512
} as const;

export type StorageAreaPort = {
  get(keys?: string | readonly string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

export type ChromeStoragePort = {
  sync: StorageAreaPort;
  local: StorageAreaPort;
  session: StorageAreaPort;
};
