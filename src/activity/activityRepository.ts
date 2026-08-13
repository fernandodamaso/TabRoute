import type { ActivityEntry, BrowserSessionId, UndoRecord, UUID } from "../domain/types";
import type { LocalRepository } from "../state/localRepository";

export async function appendActivityEntry(
  local: LocalRepository,
  entry: ActivityEntry
): Promise<void> {
  await local.appendActivity(entry);
}

export async function listActivityEntries(
  local: LocalRepository,
  before: number | undefined,
  limit: number
): Promise<ActivityEntry[]> {
  return local.listActivity(before, limit);
}

export async function getAvailableUndo(
  local: LocalRepository,
  now: number,
  browserSessionId: BrowserSessionId
): Promise<UndoRecord | undefined> {
  const records = await local.listUndo();
  return records
    .filter(
      (record) =>
        record.browserSessionId === browserSessionId && record.expiresAt > now
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0];
}

export async function clearActivity(local: LocalRepository): Promise<void> {
  await local.clearActivity();
}
