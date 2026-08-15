import { describe, expect, it } from "vitest";
import { executeActionPlan } from "../../src/actions/executeActionPlan";
import type { ActionPlan } from "../../src/actions/types";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import { validateConfiguration } from "../../src/domain/schemas";
import type {
  ActionId,
  ChromeInventory,
  Configuration,
  Snapshot,
  UUID
} from "../../src/domain/types";
import { observeInventory } from "../../src/duplicates/observations";
import { updateSnapshotFromInventory } from "../../src/snapshots/snapshotService";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";

const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
const workId = "00000000-0000-4000-8000-000000000002" as UUID;
const missingId = "00000000-0000-4000-8000-000000000099" as UUID;

function rawInventory(): ChromeInventory {
  return {
    windows: [
      { id: 1, focused: false, incognito: false, type: "normal" },
      { id: 2, focused: true, incognito: false, type: "normal" }
    ],
    tabs: [
      {
        id: 1,
        windowId: 1,
        index: 0,
        chromeGroupId: 10,
        url: "https://one.example/",
        status: "complete",
        title: "One",
        pinned: false,
        active: true,
        incognito: false,
        lastAccessed: 1
      },
      {
        id: 2,
        windowId: 2,
        index: 0,
        chromeGroupId: 20,
        url: "https://two.example/",
        status: "complete",
        title: "Two",
        pinned: false,
        active: true,
        incognito: false,
        lastAccessed: 2
      }
    ],
    groups: [
      {
        id: 10,
        windowId: 1,
        title: "Other",
        color: "grey",
        collapsed: false,
        shared: false
      },
      {
        id: 20,
        windowId: 2,
        title: "Other",
        color: "grey",
        collapsed: false,
        shared: false
      }
    ],
    capturedAt: 1
  };
}

function configurationWithWork(): Configuration {
  return createManagedGroup(
    createDefaultConfiguration(
      () => fallbackId,
      () => 1
    ),
    { name: "Work", color: "blue" },
    () => workId,
    () => 1
  );
}

describe("PR 10 fresh review regressions", () => {
  it("rejects restart-scoped pauses from portable configuration", () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );

    expect(() =>
      validateConfiguration({ ...configuration, globalPausedUntil: "restart" })
    ).toThrow();
  });

  it("rejects empty recursive condition groups", () => {
    const configuration = configurationWithWork();
    const malformed: Configuration = {
      ...configuration,
      rules: [
        {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000010" as UUID,
          targetGroupId: workId,
          priority: 1,
          positive: { kind: "all", children: [] },
          negative: [],
          actions: [{ kind: "group" }],
          enabled: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    };

    expect(() => validateConfiguration(malformed)).toThrow();
  });

  it("rejects duplicate durable UUIDs", () => {
    const configuration = configurationWithWork();
    const duplicated: Configuration = {
      ...configuration,
      groups: [...configuration.groups, { ...configuration.groups[1]! }]
    };

    expect(() => validateConfiguration(duplicated)).toThrow();
  });

  it("moves the managed-group instance already in the requested window", async () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const chrome = createFakeChromePort(rawInventory());
    const local = createMemoryLocalRepository();
    const session = createMemorySessionRepository();
    const plan: ActionPlan = {
      id: "00000000-0000-4000-8000-000000000050" as ActionId,
      source: "snapshot",
      checkpoint: "none",
      actions: [
        {
          id: "00000000-0000-4000-8000-000000000051" as ActionId,
          dependsOn: [],
          kind: "moveManagedGroup",
          managedGroupId: fallbackId,
          windowId: 2,
          index: 0
        }
      ]
    };

    await executeActionPlan(plan, {
      reads: chrome,
      mutations: chrome,
      checkpoints: { captureBefore: async () => undefined },
      local,
      session,
      configuration,
      now: () => 1_000,
      delay: async () => undefined
    });

    expect(chrome.callsFor("moveGroup")[0]?.[0]).toBe(20);
  });

  it("preserves a group-scoped snapshot when its managed group was deleted", async () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const local = createMemoryLocalRepository();
    const snapshot: Snapshot = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000060" as UUID,
      name: "Deleted group",
      kind: "named",
      scope: { kind: "group", managedGroupId: missingId },
      groups: [
        {
          managedGroupId: missingId,
          name: "Old Work",
          color: "blue",
          collapsed: false,
          order: 0,
          tabs: []
        }
      ],
      createdAt: 1,
      updatedAt: 1
    };
    expect((await local.saveSnapshot(snapshot)).ok).toBe(true);
    const session = await createMemorySessionRepository().loadSession();
    const { inventory } = observeInventory(rawInventory(), session);

    const result = await updateSnapshotFromInventory({
      local,
      snapshotId: snapshot.id,
      inventory,
      context: {
        configuration,
        ownership: {},
        associations: []
      },
      now: () => 2
    });

    expect(result).toMatchObject({ ok: false, code: "REFERENCE" });
    expect((await local.getSnapshot(snapshot.id))?.groups).toEqual(
      snapshot.groups
    );
  });
});
