import { createUuid } from "./ids";
import type {
  ChromeGroupColor,
  Configuration,
  ManagedGroup,
  UUID
} from "./types";

export function createDefaultConfiguration(
  randomUuid: () => string = () => crypto.randomUUID(),
  now = Date.now
): Configuration {
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
    duplicateSettings: {
      globalPolicy: { kind: "allow" },
      globalExclusions: [],
      trackingParameters: []
    },
    templates: [],
    snapshotIntervalMinutes: 60,
    activityLimit: 500,
    snapshotLimit: 50,
    undoTtlMs: 30000,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function renameGroup(
  configuration: Configuration,
  groupId: UUID,
  name: string
): Configuration {
  return updateManagedGroup(configuration, groupId, { name });
}

export function createManagedGroup(
  configuration: Configuration,
  input: {
    name: string;
    color: ChromeGroupColor;
    emoji?: string;
    isPersistent?: boolean;
    defaultCollapsed?: boolean;
  },
  randomUuid: () => string = () => crypto.randomUUID(),
  now = Date.now
): Configuration {
  const timestamp = now();
  const group: ManagedGroup = {
    schemaVersion: 1,
    id: createUuid(randomUuid),
    name: input.name.trim(),
    ...(input.emoji ? { emoji: input.emoji } : {}),
    color: input.color,
    isFallback: false,
    isPersistent: input.isPersistent ?? false,
    defaultOrder:
      Math.max(
        -1,
        ...configuration.groups.map((candidate) => candidate.defaultOrder)
      ) + 1,
    defaultCollapsed: input.defaultCollapsed ?? false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  if (!group.name) throw new Error("group name is required");
  return {
    ...configuration,
    groups: [...configuration.groups, group],
    updatedAt: timestamp
  };
}

export function updateManagedGroup(
  configuration: Configuration,
  groupId: UUID,
  patch: Partial<
    Pick<
      ManagedGroup,
      | "name"
      | "emoji"
      | "color"
      | "isPersistent"
      | "defaultOrder"
      | "defaultCollapsed"
      | "pausedUntil"
    >
  >,
  now = Date.now
): Configuration {
  const timestamp = now();
  const group = configuration.groups.find(
    (candidate) => candidate.id === groupId
  );
  if (!group) throw new Error("managed group not found");
  const nextName = patch.name === undefined ? group.name : patch.name.trim();
  if (!nextName) throw new Error("group name is required");
  return {
    ...configuration,
    groups: configuration.groups.map((candidate) =>
      candidate.id === groupId
        ? { ...candidate, ...patch, name: nextName, updatedAt: timestamp }
        : candidate
    ),
    updatedAt: timestamp
  };
}

export function removeManagedGroup(
  configuration: Configuration,
  groupId: UUID,
  now = Date.now
): Configuration {
  if (groupId === configuration.fallbackGroupId)
    throw new Error("fallback group cannot be removed");
  if (!configuration.groups.some((group) => group.id === groupId))
    return configuration;
  const timestamp = now();
  return {
    ...configuration,
    groups: configuration.groups.filter((group) => group.id !== groupId),
    rules: configuration.rules.filter((rule) => rule.targetGroupId !== groupId),
    updatedAt: timestamp
  };
}
