import type { ActivityEntry, UndoRecord, UUID } from "../domain/types";
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
  browserSessionId: string
): Promise<UndoRecord | undefined> {
  const undo = await local.getUndo("" as UUID);
  void undo;
  const records: UndoRecord[] = [];
  return records.find(
    (record) =>
      record.browserSessionId === browserSessionId && record.expiresAt > now
  );
}

export async function clearActivity(
  local: LocalRepository & { bags?: { activity: ActivityEntry[] } }
): Promise<void> {
  if ("bags" in local && local.bags) {
    local.bags.activity = [];
  }
}
