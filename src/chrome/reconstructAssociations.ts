import type {
  ChromeAssociation,
  ChromeInventory,
  Configuration
} from "../domain/types";
import { renderGroupTitle } from "../groups/displayTitle";

export function reconstructAssociations(
  inventory: ChromeInventory,
  configuration: Configuration,
  now = Date.now
): ChromeAssociation[] {
  // Pass 1: Build each managed UUID's unique candidate per window
  const candidateClaims: Array<{
    managedGroup: (typeof configuration.groups)[number];
    candidateGroup: (typeof inventory.groups)[number];
  }> = [];

  for (const managedGroup of configuration.groups) {
    const matches = inventory.groups.filter(
      (group) => !group.shared && group.title === renderGroupTitle(managedGroup)
    );
    const matchesByWindow = new Map<number, typeof matches>();
    for (const match of matches) {
      const windowMatches = matchesByWindow.get(match.windowId) ?? [];
      windowMatches.push(match);
      matchesByWindow.set(match.windowId, windowMatches);
    }
    for (const windowMatches of matchesByWindow.values()) {
      if (windowMatches.length === 1) {
        candidateClaims.push({
          managedGroup,
          candidateGroup: windowMatches[0]!
        });
      }
    }
  }

  // Pass 2: Discard any candidate Chrome group ID claimed by more than one managed UUID
  const claimsByChromeGroupId = new Map<number, typeof candidateClaims>();
  for (const claim of candidateClaims) {
    const existing = claimsByChromeGroupId.get(claim.candidateGroup.id) ?? [];
    existing.push(claim);
    claimsByChromeGroupId.set(claim.candidateGroup.id, existing);
  }

  const validAssociations: ChromeAssociation[] = [];
  for (const claims of claimsByChromeGroupId.values()) {
    if (claims.length === 1) {
      const { managedGroup, candidateGroup } = claims[0]!;
      validAssociations.push({
        managedGroupId: managedGroup.id,
        chromeGroupId: candidateGroup.id,
        chromeWindowId: candidateGroup.windowId,
        observedTitle: candidateGroup.title,
        observedMemberUrls: inventory.tabs
          .filter((tab) => tab.chromeGroupId === candidateGroup.id)
          .map((tab) => tab.url ?? ""),
        observedAt: now()
      });
    }
  }

  return validAssociations;
}
