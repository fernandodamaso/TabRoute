import { createDefaultConfiguration } from "../../src/domain/defaults";
import type { Configuration, PersistentTab, UUID } from "../../src/domain/types";

export const groupId = "00000000-0000-4000-8000-000000000002" as UUID;
export const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
export const persistentId = "00000000-0000-4000-8000-000000000010" as UUID;

export function persistenceConfiguration(): Configuration {
  const base = createDefaultConfiguration(() => fallbackId);
  const group = {
    schemaVersion: 1 as const,
    id: groupId,
    name: "Docs",
    color: "blue" as const,
    isFallback: false,
    enabled: true,
    isPersistent: true,
    defaultOrder: 1,
    defaultCollapsed: false,
    createdAt: 1,
    updatedAt: 1
  };
  const definition: PersistentTab = {
    schemaVersion: 1,
    id: persistentId,
    managedGroupId: groupId,
    canonicalUrl: "https://docs.example.com/guide",
    acceptedPatterns: ["https://docs.example.com/guide"],
    order: 0,
    createdAt: 1,
    updatedAt: 1
  };
  return {
    ...base,
    groups: [...base.groups, group],
    persistentTabs: [definition],
    restorePersistentGroups: true
  };
}
