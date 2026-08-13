import type {
  ChromeAssociation,
  ChromeInventory,
  Configuration,
  ManagedGroup,
  Rule,
  RuntimeSession,
  TabSnapshot,
  UUID
} from "../domain/types";
import { buildDuplicateKey, matchesExclusion } from "./normalizeUrl";
import { resolveDuplicatePolicy } from "./policy";
import { observationForTab } from "./observations";

export interface DuplicateDecision {
  survivor: TabSnapshot;
  duplicatesToClose: TabSnapshot[];
  destination: UUID | "ungrouped" | null;
  moveSurvivor: boolean;
  focusSurvivor: boolean;
}

function isSharedMember(inventory: ChromeInventory, tab: TabSnapshot): boolean {
  const group = inventory.groups.find((candidate) => candidate.id === tab.chromeGroupId);
  return group?.shared === true;
}

function effectivePlacement(
  tab: TabSnapshot,
  destination: UUID | "ungrouped" | null,
  associations: readonly ChromeAssociation[]
): boolean {
  if (destination === "ungrouped") return tab.chromeGroupId < 0;
  if (!destination) return false;
  const association = associations.find(
    (candidate) => candidate.managedGroupId === destination
  );
  return association?.chromeGroupId === tab.chromeGroupId;
}

export function selectDuplicateSurvivor(
  tabs: readonly TabSnapshot[],
  destination: UUID | "ungrouped" | null,
  associations: readonly ChromeAssociation[],
  session: RuntimeSession
): TabSnapshot {
  const sorted = [...tabs].sort((left, right) => {
    const leftPlacement = effectivePlacement(left, destination, associations);
    const rightPlacement = effectivePlacement(right, destination, associations);
    if (leftPlacement !== rightPlacement) return leftPlacement ? -1 : 1;
    if (left.lastAccessed !== right.lastAccessed) {
      return right.lastAccessed - left.lastAccessed;
    }
    const leftOrdinal =
      observationForTab(session, left.id)?.firstObservedOrdinal ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal =
      observationForTab(session, right.id)?.firstObservedOrdinal ?? Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
    return left.id - right.id;
  });
  return sorted[0]!;
}

export function resolveDuplicate(input: {
  inventory: ChromeInventory;
  tabs: readonly TabSnapshot[];
  configuration: Configuration;
  associations: readonly ChromeAssociation[];
  session: RuntimeSession;
  rule: Rule | null;
  destination: UUID | "ungrouped" | null;
  destinationManaged: boolean;
  destinationGroup: ManagedGroup | null;
}): DuplicateDecision | null {
  const eligible = input.tabs.filter(
    (tab) => tab.routing.kind === "routable" && !isSharedMember(input.inventory, tab)
  );
  if (eligible.length < 2) return null;
  const policy = resolveDuplicatePolicy(
    input.rule,
    input.destinationGroup,
    input.configuration.duplicateSettings,
    input.destinationManaged,
    eligible[0]!.routing.kind === "routable" ? eligible[0]!.routing.url : undefined
  );
  if (policy.kind === "allow") return null;
  const key = buildDuplicateKey(
    eligible[0]!,
    policy,
    input.configuration.duplicateSettings
  );
  if (!key) return null;
  const sameKey = eligible.filter((tab) => {
    if (matchesExclusion(tab.routing.kind === "routable" ? tab.routing.url : "", input.configuration.duplicateSettings.globalExclusions)) {
      return false;
    }
    return buildDuplicateKey(tab, policy, input.configuration.duplicateSettings) === key;
  });
  if (sameKey.length < 2) return null;
  const survivor = selectDuplicateSurvivor(
    sameKey,
    input.destination,
    input.associations,
    input.session
  );
  const duplicatesToClose = sameKey.filter((tab) => tab.id !== survivor.id);
  const moveSurvivor = !effectivePlacement(
    survivor,
    input.destination,
    input.associations
  );
  return {
    survivor,
    duplicatesToClose,
    destination: input.destination,
    moveSurvivor,
    focusSurvivor: true
  };
}
