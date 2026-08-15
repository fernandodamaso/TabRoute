import { isRoutableUrl } from "../chrome/types";
import type {
  ChromeInventory,
  Configuration,
  PersistentTab,
  TabSnapshot,
  UUID
} from "../domain/types";
import { deriveCanonicalUrl, matchesAcceptedUrl } from "./acceptedUrl";

export function persistentTabsForGroup(
  configuration: Configuration,
  managedGroupId: UUID
): PersistentTab[] {
  return configuration.persistentTabs
    .filter((definition) => definition.managedGroupId === managedGroupId)
    .sort((left, right) => left.order - right.order);
}

export function tabUrl(
  tab: TabSnapshot | { url?: string; routing?: TabSnapshot["routing"] }
): string | undefined {
  if ("routing" in tab && tab.routing?.kind === "routable")
    return tab.routing.url;
  return tab.url;
}

export function matchesPersistentDefinition(
  tab: TabSnapshot | { url?: string; routing?: TabSnapshot["routing"] },
  definition: PersistentTab,
  duplicateSettings?: Configuration["duplicateSettings"]
): boolean {
  const url = tabUrl(tab);
  if (!url || !isRoutableUrl(url)) return false;
  if (
    matchesAcceptedUrl(
      url,
      definition.canonicalUrl,
      definition.acceptedPatterns
    )
  ) {
    return true;
  }
  if (!duplicateSettings) return false;
  const canonicalUrl = deriveCanonicalUrl(url, duplicateSettings);
  return matchesAcceptedUrl(
    canonicalUrl,
    definition.canonicalUrl,
    definition.acceptedPatterns
  );
}

export function isGroupEligibleForRepair(
  configuration: Configuration,
  managedGroupId: UUID,
  intentionallyClosedGroupIds: readonly UUID[]
): boolean {
  const group = configuration.groups.find(
    (candidate) => candidate.id === managedGroupId
  );
  if (!group || !group.enabled) return false;
  if (group.isFallback) return true;
  if (intentionallyClosedGroupIds.includes(managedGroupId)) return false;
  return true;
}

export function managedGroupIdForTab(
  tab: { chromeGroupId: number; windowId: number },
  inventory: ChromeInventory,
  associations: readonly {
    managedGroupId: UUID;
    chromeGroupId: number;
    chromeWindowId: number;
  }[]
): UUID | undefined {
  const chromeGroup = inventory.groups.find(
    (group) => group.id === tab.chromeGroupId
  );
  if (!chromeGroup || chromeGroup.shared) return undefined;
  const association = associations.find(
    (candidate) =>
      candidate.chromeGroupId === tab.chromeGroupId &&
      candidate.chromeWindowId === tab.windowId
  );
  return association?.managedGroupId;
}

export function isTabInSharedGroup(
  tab: { chromeGroupId: number },
  inventory: ChromeInventory
): boolean {
  const group = inventory.groups.find(
    (candidate) => candidate.id === tab.chromeGroupId
  );
  return group?.shared === true;
}

export type LiveMemberUrlsResult =
  { kind: "unavailable" } | { kind: "available"; urls: string[] };

export function collectLiveMemberUrls(
  managedGroupId: UUID,
  configuration: Configuration,
  inventory: ChromeInventory,
  associations: readonly {
    managedGroupId: UUID;
    chromeGroupId: number;
    chromeWindowId: number;
  }[],
  preferredWindowId?: number
): LiveMemberUrlsResult {
  const groupAssociations = associations.filter(
    (candidate) => candidate.managedGroupId === managedGroupId
  );
  if (groupAssociations.length === 0) return { kind: "unavailable" };

  let association =
    preferredWindowId !== undefined
      ? groupAssociations.find(
          (candidate) => candidate.chromeWindowId === preferredWindowId
        )
      : undefined;
  association ??= groupAssociations[0]!;

  const chromeGroup = inventory.groups.find(
    (group) =>
      group.id === association.chromeGroupId &&
      group.windowId === association.chromeWindowId
  );
  if (!chromeGroup || chromeGroup.shared) return { kind: "unavailable" };

  return {
    kind: "available",
    urls: inventory.tabs
      .filter(
        (tab) =>
          tab.windowId === association.chromeWindowId &&
          tab.chromeGroupId === association.chromeGroupId &&
          !tab.incognito &&
          isRoutableUrl(tab.url)
      )
      .sort((left, right) => left.index - right.index)
      .map((tab) =>
        deriveCanonicalUrl(tab.url!, configuration.duplicateSettings)
      )
  };
}
