import type {
  ChromeGroupSnapshot,
  ChromeInventory,
  Configuration,
  PendingGroupRemoval,
  RuntimeSession
} from "../domain/types";
import { GUARD_QUIET_MS } from "../actions/operationGuards";

export const GROUP_SETTLEMENT_ALARM = "tabroute:group-settlement";

function urlsOverlap(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((url) => rightSet.has(url));
}

function memberEvidenceInGroup(
  pending: PendingGroupRemoval,
  groupId: number,
  inventory: ChromeInventory
): boolean {
  const memberUrls = inventory.tabs
    .filter((tab) => tab.chromeGroupId === groupId)
    .map((tab) => tab.url ?? "");
  const memberIds = inventory.tabs
    .filter((tab) => tab.chromeGroupId === groupId)
    .map((tab) => tab.id);
  return (
    urlsOverlap(pending.memberUrls, memberUrls) ||
    pending.memberTabIds.some((id) => memberIds.includes(id))
  );
}

function reconstructionCandidates(
  pending: PendingGroupRemoval,
  inventory: ChromeInventory
) {
  return inventory.groups.filter((group) => {
    if (group.shared) return false;
    if (group.windowId === pending.oldWindowId) return false;
    if (group.title !== pending.renderedTitle) return false;
    return memberEvidenceInGroup(pending, group.id, inventory);
  });
}

export function startPendingGroupRemoval(input: {
  session: RuntimeSession;
  inventoryBeforeRemoval: ChromeInventory;
  removed: ChromeGroupSnapshot;
  now: number;
}): RuntimeSession {
  const association = input.session.associations.find(
    (candidate) => candidate.chromeGroupId === input.removed.id
  );
  if (!association) return input.session;
  const memberTabIds = input.inventoryBeforeRemoval.tabs
    .filter((tab) => tab.chromeGroupId === input.removed.id)
    .map((tab) => tab.id);
  const memberUrls =
    memberTabIds.length > 0
      ? input.inventoryBeforeRemoval.tabs
          .filter((tab) => tab.chromeGroupId === input.removed.id)
          .map((tab) => tab.url ?? "")
          .filter((url) => url.length > 0)
      : association.observedMemberUrls;
  const pending: PendingGroupRemoval = {
    managedGroupId: association.managedGroupId,
    removedChromeGroupId: input.removed.id,
    oldWindowId: input.removed.windowId,
    memberTabIds,
    memberUrls,
    renderedTitle: association.observedTitle || input.removed.title,
    startedAt: input.now,
    settleAfter: input.now + GUARD_QUIET_MS
  };
  return {
    ...input.session,
    pendingGroupRemovals: [...input.session.pendingGroupRemovals, pending]
  };
}

export function settlePendingGroupRemovals(input: {
  session: RuntimeSession;
  inventory: ChromeInventory;
  configuration: Configuration;
  now: number;
}): RuntimeSession {
  let session = input.session;
  for (const pending of [...session.pendingGroupRemovals]) {
    const candidates = reconstructionCandidates(pending, input.inventory);
    if (candidates.length === 1) {
      const match = candidates[0]!;
      session = {
        ...session,
        associations: session.associations.map((association) =>
          association.managedGroupId === pending.managedGroupId
            ? {
                ...association,
                chromeGroupId: match.id,
                chromeWindowId: match.windowId,
                observedAt: input.now
              }
            : association
        ),
        pendingGroupRemovals: session.pendingGroupRemovals.filter(
          (record) => record !== pending
        )
      };
      continue;
    }
    if (candidates.length > 1) continue;
    if (input.now < pending.settleAfter) continue;
    const hasNormalWindows = input.inventory.windows.some(
      (window) => window.type === "normal"
    );
    if (!hasNormalWindows) {
      session = {
        ...session,
        pendingGroupRemovals: session.pendingGroupRemovals.filter(
          (record) => record !== pending
        )
      };
      continue;
    }
    const managed = input.configuration.groups.find(
      (group) => group.id === pending.managedGroupId
    );
    if (managed?.isPersistent) {
      session = {
        ...session,
        intentionallyClosedGroupIds: session.intentionallyClosedGroupIds.includes(
          pending.managedGroupId
        )
          ? session.intentionallyClosedGroupIds
          : [...session.intentionallyClosedGroupIds, pending.managedGroupId]
      };
    }
    session = {
      ...session,
      pendingGroupRemovals: session.pendingGroupRemovals.filter(
        (record) => record !== pending
      )
    };
  }
  return session;
}
