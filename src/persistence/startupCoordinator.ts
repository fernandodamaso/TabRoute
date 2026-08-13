import type { ChromeInventory, RuntimeSession, StartupRestoreState } from "../domain/types";
import type { ChromeEventHint } from "../domain/types";

export const WINDOW_SETTLEMENT_ALARM = "tabroute:window-settlement";
export const STARTUP_RECOVERY_ALARM = "tabroute:startup-recovery";

export const STARTUP_TIMING = {
  quietMs: 2000,
  maxMs: 15000,
  recoveryAlarmMs: 30000
} as const;

export interface AlarmScheduler {
  scheduleOneShot(name: string, when: number): Promise<void>;
}

export interface StartupCoordinatorClock {
  now(): number;
  waitInWorker(delayMs: number): Promise<void>;
}

function isRelevantStartupEvent(event: ChromeEventHint): boolean {
  return (
    event.kind === "startup" ||
    event.kind === "tabCreated" ||
    (event.kind === "tabUpdated" && event.urlChanged) ||
    (event.kind === "alarm" && event.name === STARTUP_RECOVERY_ALARM)
  );
}

export function beginStartupRestore(now: number): StartupRestoreState {
  return {
    startedAt: now,
    deadlineAt: now + STARTUP_TIMING.maxMs,
    lastRelevantEventAt: now,
    consecutiveQuietScans: 0
  };
}

export async function advanceStartupSettlement(input: {
  session: RuntimeSession;
  inventory: ChromeInventory;
  alarms: AlarmScheduler;
  clock: StartupCoordinatorClock;
  chromeEvent: ChromeEventHint;
  timing?: { quietMs: number; maxMs: number; recoveryAlarmMs: number };
}): Promise<
  | { kind: "idle"; session: RuntimeSession }
  | { kind: "waiting"; session: RuntimeSession }
  | { kind: "settled"; session: RuntimeSession; inventory: ChromeInventory }
> {
  const timing = input.timing ?? STARTUP_TIMING;
  const now = input.clock.now();
  let session = input.session;
  const event = input.chromeEvent;

  if (event.kind === "startup") {
    session = {
      ...session,
      startupRestore: {
        startedAt: now,
        deadlineAt: now + timing.maxMs,
        lastRelevantEventAt: now,
        consecutiveQuietScans: 0
      }
    };
    await input.alarms.scheduleOneShot(
      STARTUP_RECOVERY_ALARM,
      now + timing.recoveryAlarmMs
    );
    return { kind: "waiting", session };
  }

  const state = session.startupRestore;
  if (!state) {
    return { kind: "idle", session };
  }

  if (now >= state.deadlineAt) {
    return {
      kind: "settled",
      session: { ...session, startupRestore: undefined },
      inventory: input.inventory
    };
  }

  if (isRelevantStartupEvent(event)) {
    session = {
      ...session,
      startupRestore: {
        ...state,
        lastRelevantEventAt: now,
        consecutiveQuietScans: 0
      }
    };
    return { kind: "waiting", session };
  }

  const quietElapsed = now - session.startupRestore!.lastRelevantEventAt;
  if (quietElapsed < timing.quietMs) {
    return { kind: "waiting", session };
  }

  const scans = (session.startupRestore!.consecutiveQuietScans + 1) as 0 | 1 | 2;
  if (scans < 2) {
    session = {
      ...session,
      startupRestore: {
        ...session.startupRestore!,
        consecutiveQuietScans: scans
      }
    };
    await input.clock.waitInWorker(timing.quietMs);
    return { kind: "waiting", session };
  }

  return {
    kind: "settled",
    session: { ...session, startupRestore: undefined },
    inventory: input.inventory
  };
}

export function settlePendingWindowClosures(input: {
  session: RuntimeSession;
  inventory: ChromeInventory;
  now: number;
  quietMs?: number;
}): RuntimeSession {
  const quietMs = input.quietMs ?? STARTUP_TIMING.quietMs;
  const normalWindows = input.inventory.windows.filter(
    (window) => window.type === "normal" && !window.incognito
  );
  const ready = input.session.pendingWindowClosures.filter(
    (pending) => input.now >= pending.startedAt + quietMs
  );
  if (ready.length === 0) return input.session;

  let intentionallyClosedGroupIds = [...input.session.intentionallyClosedGroupIds];
  if (normalWindows.length > 0) {
    for (const pending of ready) {
      for (const managedGroupId of pending.managedGroupIds) {
        if (!intentionallyClosedGroupIds.includes(managedGroupId)) {
          intentionallyClosedGroupIds.push(managedGroupId);
        }
      }
    }
  }

  const remaining = input.session.pendingWindowClosures.filter(
    (pending) => input.now < pending.startedAt + quietMs
  );

  return {
    ...input.session,
    intentionallyClosedGroupIds,
    pendingWindowClosures: normalWindows.length === 0 ? [] : remaining
  };
}

export function recordWindowClosure(input: {
  session: RuntimeSession;
  windowId: number;
  managedGroupIds: readonly import("../domain/types").UUID[];
  tabIds: readonly number[];
  now: number;
}): RuntimeSession {
  const pending = {
    windowId: input.windowId,
    managedGroupIds: [...input.managedGroupIds],
    tabIds: [...input.tabIds],
    startedAt: input.now
  };
  const existing = input.session.pendingWindowClosures.filter(
    (record) => record.windowId !== input.windowId
  );
  return {
    ...input.session,
    pendingWindowClosures: [...existing, pending]
  };
}
