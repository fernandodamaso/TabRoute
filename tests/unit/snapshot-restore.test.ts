import { describe, expect, it } from "vitest";
import { createUuid } from "../../src/domain/ids";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { observeInventory } from "../../src/duplicates/observations";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { planSnapshotRestore } from "../../src/snapshots/restoreSnapshot";
import type { Snapshot, UUID } from "../../src/domain/types";

function baseInventory(
  tabs: Array<{
    id: number;
    url: string;
    windowId?: number;
    chromeGroupId?: number;
    incognito?: false;
  }>
) {
  return {
    windows: [
      {
        id: 1,
        focused: true,
        incognito: false as const,
        type: "normal" as const
      }
    ],
    tabs: tabs.map((tab, index) => ({
      id: tab.id,
      windowId: tab.windowId ?? 1,
      index,
      chromeGroupId: tab.chromeGroupId ?? -1,
      url: tab.url,
      title: tab.url,
      pinned: false,
      active: index === 0,
      incognito: (tab.incognito ?? false) as false,
      lastAccessed: tab.id
    })),
    groups: [],
    capturedAt: 1
  };
}

function snapshotWithGroups(
  configuration: ReturnType<typeof createDefaultConfiguration>,
  groups: Snapshot["groups"]
): Snapshot {
  return {
    schemaVersion: 1,
    id: createUuid(),
    name: "Test",
    kind: "named",
    scope: { kind: "browser" },
    groups,
    createdAt: 1,
    updatedAt: 1
  };
}

describe("planSnapshotRestore", () => {
  it("reuses one acceptable tab and creates only the missing member", async () => {
    const configuration = createDefaultConfiguration(() => createUuid());
    const groupId = configuration.fallbackGroupId;
    const raw = baseInventory([{ id: 42, url: "https://example.com/a" }]);
    const session = await createMemorySessionRepository().loadSession();
    const { inventory } = observeInventory(raw, session);
    const snapshot = snapshotWithGroups(configuration, [
      {
        managedGroupId: groupId,
        name: "Other",
        color: "grey",
        collapsed: false,
        order: 0,
        tabs: [
          {
            url: "https://example.com/a",
            title: "A",
            duplicateKey: "https://example.com/a",
            order: 0
          },
          {
            url: "https://example.com/b",
            title: "B",
            duplicateKey: "https://example.com/b",
            order: 1
          }
        ]
      }
    ]);
    const plan = planSnapshotRestore(snapshot, inventory, {
      configuration,
      associations: [],
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: [],
      session
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.reusedTabIds).toEqual([42]);
    expect(
      plan.actions.filter((action) => action.kind === "createTab")
    ).toHaveLength(1);
  });

  it("rejects deleted group UUIDs before any actions", async () => {
    const configuration = createDefaultConfiguration(() => createUuid());
    const missingId = "00000000-0000-4000-8000-000000000099" as UUID;
    const snapshot = snapshotWithGroups(configuration, [
      {
        managedGroupId: missingId,
        name: "Gone",
        color: "blue",
        collapsed: false,
        order: 0,
        tabs: [
          {
            url: "https://example.com/",
            title: "Example",
            duplicateKey: "https://example.com/",
            order: 0
          }
        ]
      }
    ]);
    const plan = planSnapshotRestore(
      snapshot,
      { ...baseInventory([]), tabs: [] },
      {
        configuration,
        associations: [],
        ownership: {},
        lastFocusedWindowId: 1,
        intentionallyClosedGroupIds: [],
        session: await createMemorySessionRepository().loadSession()
      }
    );
    expect(plan).toEqual({
      ok: false,
      code: "SNAPSHOT_GROUP_MISSING",
      missingGroups: [{ id: missingId, name: "Gone" }]
    });
  });

  it("does not create native groups for empty snapshot groups", async () => {
    const configuration = createDefaultConfiguration(() => createUuid());
    const raw = baseInventory([]);
    const session = await createMemorySessionRepository().loadSession();
    const { inventory } = observeInventory(raw, session);
    const snapshot = snapshotWithGroups(configuration, [
      {
        managedGroupId: configuration.fallbackGroupId,
        name: "Other",
        color: "grey",
        collapsed: false,
        order: 0,
        tabs: []
      }
    ]);
    const plan = planSnapshotRestore(snapshot, inventory, {
      configuration,
      associations: [],
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: [],
      session
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.actions).toHaveLength(0);
  });

  it("claims each live tab at most once", async () => {
    const configuration = createDefaultConfiguration(() => createUuid());
    const groupId = configuration.fallbackGroupId;
    const raw = baseInventory([{ id: 42, url: "https://example.com/shared" }]);
    const session = await createMemorySessionRepository().loadSession();
    const { inventory } = observeInventory(raw, session);
    const snapshot = snapshotWithGroups(configuration, [
      {
        managedGroupId: groupId,
        name: "Other",
        color: "grey",
        collapsed: false,
        order: 0,
        tabs: [
          {
            url: "https://example.com/shared",
            title: "Shared",
            duplicateKey: "https://example.com/shared",
            order: 0
          }
        ]
      },
      {
        managedGroupId: groupId,
        name: "Other duplicate entry",
        color: "grey",
        collapsed: false,
        order: 1,
        tabs: [
          {
            url: "https://example.com/shared",
            title: "Shared again",
            duplicateKey: "https://example.com/shared",
            order: 0
          }
        ]
      }
    ]);
    const plan = planSnapshotRestore(snapshot, inventory, {
      configuration,
      associations: [],
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: [],
      session
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.reusedTabIds).toEqual([42]);
    expect(
      plan.actions.filter((action) => action.kind === "createTab")
    ).toHaveLength(1);
  });

  it("excludes incognito tabs from reuse", async () => {
    const configuration = createDefaultConfiguration(() => createUuid());
    const raw = {
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
          id: 42,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://example.com/",
          title: "Example",
          pinned: false,
          active: true,
          incognito: true as unknown as false,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    };
    const session = await createMemorySessionRepository().loadSession();
    const { inventory } = observeInventory(raw, session);
    const snapshot = snapshotWithGroups(configuration, [
      {
        managedGroupId: configuration.fallbackGroupId,
        name: "Other",
        color: "grey",
        collapsed: false,
        order: 0,
        tabs: [
          {
            url: "https://example.com/",
            title: "Example",
            duplicateKey: "https://example.com/",
            order: 0
          }
        ]
      }
    ]);
    const plan = planSnapshotRestore(snapshot, inventory, {
      configuration,
      associations: [],
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: [],
      session
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.reusedTabIds).toEqual([]);
    expect(
      plan.actions.filter((action) => action.kind === "createTab")
    ).toHaveLength(1);
  });
});
