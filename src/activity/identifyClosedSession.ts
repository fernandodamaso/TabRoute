import type { RecentlyClosedTab } from "../domain/types";

export function identifyClosedSession(
  before: readonly RecentlyClosedTab[],
  after: readonly RecentlyClosedTab[],
  target: { url: string; title: string }
): string | null {
  const beforeIds = new Set(
    before.map((entry) => entry.sessionId).filter((id): id is string => !!id)
  );
  const matches = after.filter((entry) => {
    if (!entry.sessionId || beforeIds.has(entry.sessionId)) return false;
    return entry.url === target.url && entry.title === target.title;
  });
  if (matches.length !== 1) return null;
  return matches[0]!.sessionId ?? null;
}
