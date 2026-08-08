import { createUuid } from "./ids";
import type { Configuration, ManagedGroup, UUID } from "./types";

export function createDefaultConfiguration(randomUuid: () => string = () => crypto.randomUUID(), now = Date.now): Configuration {
  const timestamp = now();
  const fallbackGroupId = createUuid(randomUuid);
  const fallback: ManagedGroup = {
    schemaVersion: 1,
    id: fallbackGroupId,
    name: "Other",
    color: "grey",
    isFallback: true,
    isPersistent: false,
    defaultOrder: 0,
    defaultCollapsed: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return {
    schemaVersion: 1,
    fallbackGroupId,
    automationEnabled: true,
    groups: [fallback],
    rules: [],
    persistentTabs: [],
    duplicateSettings: { globalPolicy: { kind: "allow" }, globalExclusions: [], trackingParameters: [] },
    templates: [],
    snapshotIntervalMinutes: 60,
    activityLimit: 500,
    snapshotLimit: 50,
    undoTtlMs: 30000,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function renameGroup(configuration: Configuration, groupId: UUID, name: string): Configuration {
  return {
    ...configuration,
    groups: configuration.groups.map((group) => group.id === groupId ? { ...group, name, updatedAt: Date.now() } : group),
    updatedAt: Date.now()
  };
}
