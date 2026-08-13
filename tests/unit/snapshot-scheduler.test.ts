import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createUuid } from "../../src/domain/ids";
import { createRecordedAlarmScheduler } from "../../src/background/alarmScheduler";
import {
  ensureSnapshotAlarms,
  handleSnapshotAlarm,
  noteSnapshotRelevantEvent,
  SNAPSHOT_ALARMS
} from "../../src/snapshots/snapshotScheduler";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { observeInventory } from "../../src/duplicates/observations";

describe("snapshot scheduler", () => {
  it("recreates the configured interval alarm after worker recreation", async () => {
    const configuration = createDefaultConfiguration(() => crypto.randomUUID());
    const alarms = createRecordedAlarmScheduler();
    await ensureSnapshotAlarms(configuration, alarms);
    expect(alarms.calls).toContainEqual({
      kind: "periodic",
      name: SNAPSHOT_ALARMS.interval,
      minutes: configuration.snapshotIntervalMinutes
    });
  });

  it("keeps a fresh checkpoint without a shutdown callback", async () => {
    const local = createMemoryLocalRepository();
    const sessionRepo = createMemorySessionRepository();
    const alarms = createRecordedAlarmScheduler();
    const configuration = createDefaultConfiguration(() => crypto.randomUUID());
    const raw = {
      windows: [{ id: 1, focused: true, incognito: false as const, type: "normal" as const }],
      tabs: [
        {
          id: 42,
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
    };
    const session = await sessionRepo.loadSession();
    const { inventory } = observeInventory(raw, session);
    const reads = {
      readInventory: async () => raw,
      getLastFocusedNormalWindowId: async () => 1,
      getRecentlyClosed: async () => []
    };
    await noteSnapshotRelevantEvent(
      {
        kind: "tabUpdated",
        tabId: 42,
        urlChanged: true,
        groupChanged: false,
        pinnedChanged: false
      },
      {
        configuration: () => configuration,
        local,
        session: sessionRepo,
        reads,
        alarms,
        now: () => 1000
      }
    );
    expect(await local.loadShutdownCheckpoint()).not.toBeNull();
    expect(alarms.calls).toContainEqual(
      expect.objectContaining({ kind: "oneShot", name: SNAPSHOT_ALARMS.checkpoint })
    );
    void inventory;
  });

  it("skips automatic capture when only named snapshots fill the limit", async () => {
    const local = createMemoryLocalRepository({
      snapshots: Array.from({ length: 50 }, (_, index) => ({
        schemaVersion: 1 as const,
        id: createUuid(),
        name: `named-${index}`,
        kind: "named" as const,
        scope: { kind: "browser" as const },
        groups: [],
        createdAt: index,
        updatedAt: index
      }))
    });
    const sessionRepo = createMemorySessionRepository();
    const configuration = createDefaultConfiguration(() => crypto.randomUUID());
    const reads = {
      readInventory: async () => ({
        windows: [],
        tabs: [],
        groups: [],
        capturedAt: 1
      }),
      getLastFocusedNormalWindowId: async () => null,
      getRecentlyClosed: async () => []
    };
    await handleSnapshotAlarm(SNAPSHOT_ALARMS.interval, {
      configuration: () => configuration,
      local,
      session: sessionRepo,
      reads,
      alarms: createRecordedAlarmScheduler(),
      now: () => 5000
    });
    expect((await local.listSnapshots()).filter((snapshot) => snapshot.kind === "automatic")).toHaveLength(0);
  });
});
