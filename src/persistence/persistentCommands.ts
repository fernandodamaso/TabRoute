import { createUuid } from "../domain/ids";
import type { Configuration, PersistentTab, UUID } from "../domain/types";
import { deriveCanonicalUrl, isValidCanonicalUrl } from "./acceptedUrl";
import { persistentTabsForGroup } from "./requirements";

export type PersistentTabDraft = Omit<
  PersistentTab,
  "schemaVersion" | "id" | "createdAt" | "updatedAt"
> & { id?: UUID };

export function savePersistentTab(
  configuration: Configuration,
  draft: PersistentTabDraft,
  now: () => number,
  randomUuid: () => string = () => crypto.randomUUID()
): Configuration {
  if (!isValidCanonicalUrl(draft.canonicalUrl)) {
    throw new Error("invalid canonical URL");
  }
  if (!configuration.groups.some((group) => group.id === draft.managedGroupId)) {
    throw new Error("managed group not found");
  }
  const timestamp = now();
  const id = (draft.id ?? createUuid(randomUuid)) as UUID;
  const nextTab: PersistentTab = {
    schemaVersion: 1,
    id,
    managedGroupId: draft.managedGroupId,
    canonicalUrl: draft.canonicalUrl,
    acceptedPatterns: [...draft.acceptedPatterns],
    order: draft.order,
    createdAt: draft.id
      ? configuration.persistentTabs.find((tab) => tab.id === draft.id)?.createdAt ??
        timestamp
      : timestamp,
    updatedAt: timestamp
  };
  const exists = configuration.persistentTabs.some((tab) => tab.id === id);
  const persistentTabs = exists
    ? configuration.persistentTabs.map((tab) => (tab.id === id ? nextTab : tab))
    : [...configuration.persistentTabs, nextTab];
  return { ...configuration, persistentTabs, updatedAt: timestamp };
}

export function removePersistent(
  configuration: Configuration,
  persistentTabId: UUID,
  now: () => number
): Configuration {
  if (!configuration.persistentTabs.some((tab) => tab.id === persistentTabId)) {
    throw new Error("persistent tab not found");
  }
  const timestamp = now();
  return {
    ...configuration,
    persistentTabs: configuration.persistentTabs.filter(
      (tab) => tab.id !== persistentTabId
    ),
    updatedAt: timestamp
  };
}

export function reorderPersistentTabs(
  configuration: Configuration,
  managedGroupId: UUID,
  orderedIds: readonly UUID[],
  now: () => number
): Configuration {
  const groupTabs = persistentTabsForGroup(configuration, managedGroupId);
  const idSet = new Set(groupTabs.map((tab) => tab.id));
  if (
    orderedIds.length !== groupTabs.length ||
    orderedIds.some((id) => !idSet.has(id))
  ) {
    throw new Error("invalid persistent tab order");
  }
  const timestamp = now();
  const orderMap = new Map(orderedIds.map((id, index) => [id, index]));
  return {
    ...configuration,
    persistentTabs: configuration.persistentTabs.map((tab) =>
      tab.managedGroupId === managedGroupId && orderMap.has(tab.id)
        ? { ...tab, order: orderMap.get(tab.id)!, updatedAt: timestamp }
        : tab
    ),
    updatedAt: timestamp
  };
}

export function makePersistentDefinition(
  configuration: Configuration,
  managedGroupId: UUID,
  url: string,
  now: () => number,
  randomUuid: () => string = () => crypto.randomUUID()
): Configuration {
  const canonicalUrl = deriveCanonicalUrl(url, configuration.duplicateSettings);
  const existing = configuration.persistentTabs.find(
    (tab) =>
      tab.managedGroupId === managedGroupId && tab.canonicalUrl === canonicalUrl
  );
  if (existing) return configuration;
  const order =
    persistentTabsForGroup(configuration, managedGroupId).length;
  return savePersistentTab(
    configuration,
    {
      managedGroupId,
      canonicalUrl,
      acceptedPatterns: [canonicalUrl],
      order
    },
    now,
    randomUuid
  );
}

export function pinGroupDefinitions(
  configuration: Configuration,
  managedGroupId: UUID,
  memberUrls: readonly string[],
  now: () => number,
  randomUuid: () => string = () => crypto.randomUUID()
): Configuration {
  const canonicalMembers = memberUrls.map((url) =>
    deriveCanonicalUrl(url, configuration.duplicateSettings)
  );
  const memberSet = new Set(canonicalMembers);
  let next: Configuration = {
    ...configuration,
    groups: configuration.groups.map((group) =>
      group.id === managedGroupId
        ? { ...group, isPersistent: true, updatedAt: now() }
        : group
    ),
    persistentTabs: configuration.persistentTabs.filter(
      (tab) =>
        tab.managedGroupId !== managedGroupId || memberSet.has(tab.canonicalUrl)
    ),
    updatedAt: now()
  };
  for (const [index, url] of memberUrls.entries()) {
    const canonicalUrl = deriveCanonicalUrl(url, next.duplicateSettings);
    const existing = next.persistentTabs.find(
      (tab) =>
        tab.managedGroupId === managedGroupId && tab.canonicalUrl === canonicalUrl
    );
    if (existing) {
      next = savePersistentTab(
        next,
        { ...existing, order: index },
        now,
        randomUuid
      );
    } else {
      next = savePersistentTab(
        next,
        {
          managedGroupId,
          canonicalUrl,
          acceptedPatterns: [canonicalUrl],
          order: index
        },
        now,
        randomUuid
      );
    }
  }
  return next;
}

export function setRestorePersistentGroups(
  configuration: Configuration,
  enabled: boolean,
  now: () => number
): Configuration {
  return {
    ...configuration,
    restorePersistentGroups: enabled,
    updatedAt: now()
  };
}
