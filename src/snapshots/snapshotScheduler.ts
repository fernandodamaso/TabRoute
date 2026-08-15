import type { AlarmScheduler } from "../background/alarmScheduler";
import { appendActivityEntry } from "../activity/activityRepository";
import { captureSnapshot, createCheckpointSnapshotId } from "./captureSnapshot";
import {
  buildSnapshotContext,
  captureAutomaticSnapshot
} from "./snapshotService";
import type { Configuration, ShutdownCheckpoint } from "../domain/types";
import type { ChromeEventHint } from "../domain/types";
import {
  createActivityEntry,
  type LocalRepository
} from "../state/localRepository";
import { observeInventory } from "../duplicates/observations";
import type { SessionRepository } from "../state/sessionRepository";
import type { ChromeReadPort } from "../chrome/types";

export const SNAPSHOT_ALARMS = {
  interval: "tabroute:snapshot-interval",
  checkpoint: "tabroute:shutdown-checkpoint"
} as const;

const CHECKPOINT_STALE_MS = 30_000;
const CHECKPOINT_DEBOUNCE_MS = 2_000;

export interface SnapshotSchedulerDeps {
  configuration: () => Configuration;
  local: LocalRepository;
  session: SessionRepository;
  reads: ChromeReadPort;
  alarms: AlarmScheduler;
  now?: () => number;
}

function isSnapshotRelevantEvent(event: ChromeEventHint): boolean {
  switch (event.kind) {
    case "tabCreated":
    case "tabRemoved":
    case "tabMoved":
    case "tabAttached":
    case "tabDetached":
    case "groupCreated":
    case "groupUpdated":
    case "groupMoved":
    case "groupRemoved":
    case "windowFocusChanged":
    case "windowRemoved":
      return true;
    case "tabUpdated":
      return event.urlChanged || event.groupChanged;
    default:
      return false;
  }
}

async function readBrowserInventory(deps: SnapshotSchedulerDeps): Promise<{
  raw: Awaited<ReturnType<ChromeReadPort["readInventory"]>>;
  inventory: ReturnType<typeof observeInventory>["inventory"];
}> {
  const raw = await deps.reads.readInventory();
  const session = await deps.session.loadSession();
  return { raw, inventory: observeInventory(raw, session).inventory };
}

async function recordSnapshotFailure(
  deps: SnapshotSchedulerDeps,
  action: string,
  errorCode: string
): Promise<void> {
  try {
    await appendActivityEntry(
      deps.local,
      createActivityEntry({
        action,
        result: "failure",
        affectedManagedGroupIds: [],
        affectedUrls: [],
        errorCode,
        createdAt: deps.now?.() ?? Date.now()
      })
    );
  } catch {
    // Snapshot/checkpoint failure stays non-fatal if Activity is also unavailable.
  }
}

export async function ensureSnapshotAlarms(
  configuration: Configuration,
  alarms: AlarmScheduler
): Promise<void> {
  await alarms.schedulePeriodic(
    SNAPSHOT_ALARMS.interval,
    configuration.snapshotIntervalMinutes
  );
}

export async function noteSnapshotRelevantEvent(
  event: ChromeEventHint,
  deps: SnapshotSchedulerDeps
): Promise<void> {
  if (!isSnapshotRelevantEvent(event)) return;
  const now = deps.now?.() ?? Date.now();
  const checkpoint = await deps.local.loadShutdownCheckpoint();
  if (checkpoint && now - checkpoint.capturedAt < CHECKPOINT_STALE_MS) {
    await deps.alarms.scheduleOneShot(
      SNAPSHOT_ALARMS.checkpoint,
      now + CHECKPOINT_DEBOUNCE_MS
    );
    return;
  }
  const configuration = deps.configuration();
  const { raw, inventory } = await readBrowserInventory(deps);
  const context = await buildSnapshotContext({
    configuration,
    local: deps.local,
    inventory: raw
  });
  const snapshot = captureSnapshot({ kind: "browser" }, inventory, context, {
    id: createCheckpointSnapshotId(),
    name: "shutdown-latest",
    kind: "checkpoint",
    now
  });
  const record: ShutdownCheckpoint = {
    schemaVersion: 1,
    snapshot,
    capturedAt: now
  };
  const result = await deps.local.saveShutdownCheckpoint(record);
  if (!result.ok) {
    await recordSnapshotFailure(deps, "Shutdown checkpoint", result.code);
  }
  await deps.alarms.scheduleOneShot(
    SNAPSHOT_ALARMS.checkpoint,
    now + CHECKPOINT_DEBOUNCE_MS
  );
}

export async function handleSnapshotAlarm(
  name: string,
  deps: SnapshotSchedulerDeps
): Promise<void> {
  if (name === SNAPSHOT_ALARMS.interval) {
    const configuration = deps.configuration();
    const { raw, inventory } = await readBrowserInventory(deps);
    const context = await buildSnapshotContext({
      configuration,
      local: deps.local,
      inventory: raw
    });
    const result = await captureAutomaticSnapshot({
      local: deps.local,
      inventory,
      context,
      now: deps.now
    });
    if (!result.ok) {
      await recordSnapshotFailure(deps, "Automatic snapshot", result.code);
    }
    return;
  }
  if (name !== SNAPSHOT_ALARMS.checkpoint) return;
  const now = deps.now?.() ?? Date.now();
  const configuration = deps.configuration();
  const { raw, inventory } = await readBrowserInventory(deps);
  const context = await buildSnapshotContext({
    configuration,
    local: deps.local,
    inventory: raw
  });
  const snapshot = captureSnapshot({ kind: "browser" }, inventory, context, {
    id: createCheckpointSnapshotId(),
    name: "shutdown-latest",
    kind: "checkpoint",
    now
  });
  const result = await deps.local.saveShutdownCheckpoint({
    schemaVersion: 1,
    snapshot,
    capturedAt: now
  });
  if (!result.ok) {
    await recordSnapshotFailure(deps, "Shutdown checkpoint", result.code);
  }
}
