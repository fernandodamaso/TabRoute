import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createRecordedAlarmScheduler } from "../../src/background/alarmScheduler";
import {
  ensureSnapshotAlarms,
  handleSnapshotAlarm,
  SNAPSHOT_ALARMS
} from "../../src/snapshots/snapshotScheduler";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";

describe("snapshot alarms component", () => {
  it("recreates alarms after worker recreation", async () => {
    const configuration = createDefaultConfiguration(() => crypto.randomUUID());
    const first = createRecordedAlarmScheduler();
    await ensureSnapshotAlarms(configuration, first);
    const second = createRecordedAlarmScheduler();
    await ensureSnapshotAlarms(configuration, second);
    expect(second.calls).toContainEqual({
      kind: "periodic",
      name: SNAPSHOT_ALARMS.interval,
      minutes: configuration.snapshotIntervalMinutes
    });
  });

  it("completes interval and checkpoint alarm handlers", async () => {
    const local = createMemoryLocalRepository();
    const sessionRepo = createMemorySessionRepository();
    const configuration = createDefaultConfiguration(() => crypto.randomUUID());
    const reads = {
      readInventory: async () => ({
        windows: [
          {
            id: 1,
            focused: true,
            incognito: false as const,
            type: "normal" as const
          }
        ],
        tabs: [
          {
            id: 1,
            windowId: 1,
            index: 0,
            chromeGroupId: -1,
            url: "https://example.com/",
            title: "Example",
            pinned: false,
            active: true,
            incognito: false as const,
            lastAccessed: 1
          }
        ],
        groups: [],
        capturedAt: 1
      }),
      getLastFocusedNormalWindowId: async () => 1,
      getRecentlyClosed: async () => []
    };
    const deps = {
      configuration: () => configuration,
      local,
      session: sessionRepo,
      reads,
      alarms: createRecordedAlarmScheduler(),
      now: () => 2000
    };
    await handleSnapshotAlarm(SNAPSHOT_ALARMS.interval, deps);
    await handleSnapshotAlarm(SNAPSHOT_ALARMS.checkpoint, deps);
    expect(
      (await local.listSnapshots()).some(
        (snapshot) => snapshot.kind === "automatic"
      )
    ).toBe(true);
    expect(await local.loadShutdownCheckpoint()).not.toBeNull();
  });
});
