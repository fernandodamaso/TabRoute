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
  return configuration.groups.flatMap((managedGroup) => {
    const matches = inventory.groups.filter(
      (group) => !group.shared && group.title === renderGroupTitle(managedGroup)
    );
    const matchesByWindow = new Map<number, typeof matches>();
    for (const match of matches) {
      const windowMatches = matchesByWindow.get(match.windowId) ?? [];
      windowMatches.push(match);
      matchesByWindow.set(match.windowId, windowMatches);
    }
    return [...matchesByWindow.values()].flatMap((windowMatches) => {
      const match = windowMatches.length === 1 ? windowMatches[0] : undefined;
      return match
        ? [
            {
              managedGroupId: managedGroup.id,
              chromeGroupId: match.id,
              chromeWindowId: match.windowId,
              observedTitle: match.title,
              observedMemberUrls: inventory.tabs
                .filter((tab) => tab.chromeGroupId === match.id)
                .map((tab) => tab.url ?? ""),
              observedAt: now()
            }
          ]
        : [];
    });
  });
}
