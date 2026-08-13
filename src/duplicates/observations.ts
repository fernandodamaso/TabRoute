import type {
  BrowserInventory,
  ChromeInventory,
  RuntimeSession,
  TabObservation,
  TabSnapshot
} from "../domain/types";
import { isRoutableUrl } from "./normalizeUrl";

export function observeInventory(
  raw: ChromeInventory,
  session: RuntimeSession
): { inventory: BrowserInventory; session: RuntimeSession } {
  const observations = new Map(
    session.tabObservations.map((observation) => [observation.tabId, observation])
  );
  let nextOrdinal = session.nextObservationOrdinal;
  const sortedForBootstrap = [...raw.tabs].sort((left, right) => {
    if (left.windowId !== right.windowId) return left.windowId - right.windowId;
    if (left.index !== right.index) return left.index - right.index;
    return left.id - right.id;
  });
  const bootstrapping = session.tabObservations.length === 0;
  const updatedObservations: TabObservation[] = [];
  for (const tab of sortedForBootstrap) {
    const existing = observations.get(tab.id);
    if (existing) {
      updatedObservations.push({
        ...existing,
        lastObservedUrl: tab.url ?? existing.lastObservedUrl
      });
      continue;
    }
    const ordinal = bootstrapping ? nextOrdinal++ : nextOrdinal++;
    updatedObservations.push({
      tabId: tab.id,
      firstObservedAt: Date.now(),
      firstObservedOrdinal: ordinal,
      lastObservedUrl: tab.url ?? ""
    });
  }
  const tabs: TabSnapshot[] = raw.tabs.map((tab) => ({
    ...tab,
    routing: isRoutableUrl(tab.url)
      ? { kind: "routable", url: tab.url }
      : { kind: "pending" }
  }));
  return {
    inventory: { ...raw, tabs },
    session: {
      ...session,
      nextObservationOrdinal: nextOrdinal,
      tabObservations: updatedObservations
    }
  };
}

export function observationForTab(
  session: RuntimeSession,
  tabId: number
): TabObservation | undefined {
  return session.tabObservations.find((observation) => observation.tabId === tabId);
}
