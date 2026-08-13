import type { ActivityEntry, BrowserSessionId, UndoRecord } from "../domain/types";
import type { LocalRepository } from "../state/localRepository";
import { createActivityEntry } from "../state/localRepository";

export type SyncRevisionActivityResult =
  | { kind: "applied" }
  | { kind: "invalid"; reason: string }
  | { kind: "pending" };

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

export async function recordSyncRevisionActivity(
  local: LocalRepository,
  result: SyncRevisionActivityResult,
  now: number
): Promise<void> {
  if (result.kind === "applied") {
    await appendActivityEntry(
      local,
      createActivityEntry({
        action: "Configuration synced",
        result: "success",
        affectedManagedGroupIds: [],
        affectedUrls: [],
        createdAt: now
      })
    );
    return;
  }
  if (result.kind === "invalid") {
    await appendActivityEntry(
      local,
      createActivityEntry({
        action: "Configuration sync failed",
        result: "failure",
        affectedManagedGroupIds: [],
        affectedUrls: [],
        errorCode: result.reason,
        createdAt: now
      })
    );
  }
}
