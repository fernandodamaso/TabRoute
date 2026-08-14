import { describe, expect, it } from "vitest";
import { identifyClosedSession } from "../../src/activity/identifyClosedSession";
import {
  deriveUndoPlacementFromTab,
  resolveUndoPlacement,
  undoPlanIsDegraded,
  WINDOW_ID_NONE,
  planUndoActions
} from "../../src/activity/undoPlanner";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { renderGroupTitle } from "../../src/groups/displayTitle";
import type { UUID } from "../../src/domain/types";

describe("undo planner", () => {
  it("identifyClosedSession returns null for 0 and N matches", () => {
    const before = [
      { sessionId: "a", url: "https://x.test/", title: "X", lastAccessed: 1 }
    ];
    expect(
      identifyClosedSession(before, before, {
        url: "https://x.test/",
        title: "X"
      })
    ).toBeNull();
    const after = [
      { sessionId: "b", url: "https://x.test/", title: "X", lastAccessed: 2 },
      { sessionId: "c", url: "https://x.test/", title: "X", lastAccessed: 3 }
    ];
    expect(
      identifyClosedSession(before, after, {
        url: "https://x.test/",
        title: "X"
      })
    ).toBeNull();
  });

  it("never uses WINDOW_ID_NONE as restore window", () => {
    const result = planUndoActions({
      payload: {
        kind: "restoreClosedTab",
        url: "https://example.com/",
        title: "Example",
        placement: { kind: "ungrouped", index: 0 }
      },
      windowId: WINDOW_ID_NONE,
      configuration: createDefaultConfiguration(
        () => "00000000-0000-4000-8000-000000000001"
      ),
      inventory: {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 1
      }
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("derives managed, unmanaged, and ungrouped undo placement from tab inventory", () => {
    const workId = "00000000-0000-4000-8000-000000000002" as UUID;
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [],
      groups: [
        {
          id: 10,
          windowId: 1,
          title: "Work",
          color: "blue" as const,
          collapsed: false,
          shared: false
        },
        {
          id: 99,
          windowId: 1,
          title: "Shared",
          color: "grey" as const,
          collapsed: false,
          shared: true
        }
      ],
      capturedAt: 1
    };
    const associations = [
      {
        managedGroupId: workId,
        chromeGroupId: 10,
        chromeWindowId: 1,
        observedTitle: "Work",
        observedMemberUrls: [],
        observedAt: 1
      }
    ];

    expect(
      deriveUndoPlacementFromTab(
        { windowId: 1, index: 2, chromeGroupId: 10 },
        inventory,
        associations
      )
    ).toEqual({
      kind: "managedGroup",
      managedGroupId: workId,
      windowIdHint: 1,
      index: 2
    });
    expect(
      deriveUndoPlacementFromTab(
        { windowId: 1, index: 1, chromeGroupId: 77 },
        inventory,
        associations
      )
    ).toEqual({
      kind: "unmanagedGroup",
      chromeGroupIdHint: 77,
      windowIdHint: 1,
      index: 1
    });
    expect(
      deriveUndoPlacementFromTab(
        { windowId: 1, index: 0, chromeGroupId: -1 },
        inventory,
        associations
      )
    ).toEqual({
      kind: "ungrouped",
      windowIdHint: 1,
      index: 0
    });
  });

  it("assigns deleted managed groups to Other with moveTabs and marks degraded", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const deletedId = "00000000-0000-4000-8000-000000000099" as UUID;
    const plan = planUndoActions({
      payload: {
        kind: "restoreClosedTab",
        sessionId: "closed-1",
        url: "https://example.com/",
        title: "Example",
        placement: {
          kind: "managedGroup",
          managedGroupId: deletedId,
          windowIdHint: 1,
          index: 2
        }
      },
      windowId: 1,
      configuration,
      inventory: {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 1
      },
      associations: []
    });
    expect("status" in plan).toBe(false);
    if ("status" in plan) return;
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "restoreClosedTab",
      "assignTabsToManagedGroup",
      "moveTabs"
    ]);
    const assign = plan.actions[1];
    expect(assign?.kind).toBe("assignTabsToManagedGroup");
    if (assign?.kind !== "assignTabsToManagedGroup") return;
    expect(assign.managedGroupId).toBe(configuration.fallbackGroupId);
    expect(
      undoPlanIsDegraded(
        {
          kind: "restoreClosedTab",
          sessionId: "closed-1",
          url: "https://example.com/",
          title: "Example",
          placement: {
            kind: "managedGroup",
            managedGroupId: deletedId,
            windowIdHint: 1,
            index: 2
          }
        },
        1,
        configuration,
        {
          windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
          tabs: [],
          groups: [],
          capturedAt: 1
        },
        []
      )
    ).toBe(true);
  });

  it("uses managed group home window when windowIdHint is gone", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const workId = "00000000-0000-4000-8000-000000000002" as UUID;
    const workGroup = {
      schemaVersion: 1 as const,
      id: workId,
      name: "Work",
      color: "blue" as const,
      isFallback: false,
      enabled: true,
      isPersistent: false,
      defaultOrder: 1,
      defaultCollapsed: false,
      createdAt: 1,
      updatedAt: 1
    };
    const config = {
      ...configuration,
      groups: [...configuration.groups, workGroup]
    };
    const inventory = {
      windows: [
        { id: 1, focused: false, incognito: false, type: "normal" as const },
        { id: 2, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [],
      groups: [
        {
          id: 10,
          windowId: 2,
          title: renderGroupTitle(workGroup),
          color: "blue" as const,
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const associations = [
      {
        managedGroupId: workId,
        chromeGroupId: 10,
        chromeWindowId: 2,
        observedTitle: renderGroupTitle(workGroup),
        observedMemberUrls: [],
        observedAt: 1
      }
    ];
    const resolved = resolveUndoPlacement(
      {
        kind: "managedGroup",
        managedGroupId: workId,
        windowIdHint: 99,
        index: 0
      },
      2,
      config,
      inventory,
      associations
    );
    expect(resolved).toMatchObject({
      kind: "managedGroup",
      managedGroupId: workId,
      windowId: 2,
      degraded: true
    });
  });

  it("falls back to Other in the focused window when managed home is gone", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const workId = "00000000-0000-4000-8000-000000000002" as UUID;
    const workGroup = {
      schemaVersion: 1 as const,
      id: workId,
      name: "Work",
      color: "blue" as const,
      isFallback: false,
      enabled: true,
      isPersistent: false,
      defaultOrder: 1,
      defaultCollapsed: false,
      createdAt: 1,
      updatedAt: 1
    };
    const config = {
      ...configuration,
      groups: [...configuration.groups, workGroup]
    };
    const resolved = resolveUndoPlacement(
      {
        kind: "managedGroup",
        managedGroupId: workId,
        windowIdHint: 1,
        index: 0
      },
      2,
      config,
      {
        windows: [{ id: 2, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 1
      },
      [
        {
          managedGroupId: workId,
          chromeGroupId: 10,
          chromeWindowId: 1,
          observedTitle: "Work",
          observedMemberUrls: [],
          observedAt: 1
        }
      ]
    );
    expect(resolved).toMatchObject({
      kind: "managedGroup",
      managedGroupId: configuration.fallbackGroupId,
      windowId: 2,
      degraded: true
    });
  });

  it("routes stale unmanaged group to Other when the hinted window is gone", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const plan = planUndoActions({
      payload: {
        kind: "restoreClosedTab",
        sessionId: "closed-1",
        url: "https://example.com/",
        title: "Example",
        placement: {
          kind: "unmanagedGroup",
          chromeGroupIdHint: 77,
          windowIdHint: 99,
          index: 1
        }
      },
      windowId: 2,
      configuration,
      inventory: {
        windows: [{ id: 2, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 1
      },
      associations: []
    });
    expect("status" in plan).toBe(false);
    if ("status" in plan) return;
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "restoreClosedTab",
      "assignTabsToManagedGroup",
      "moveTabs"
    ]);
    const assign = plan.actions[1];
    expect(assign?.kind).toBe("assignTabsToManagedGroup");
    if (assign?.kind !== "assignTabsToManagedGroup") return;
    expect(assign.managedGroupId).toBe(configuration.fallbackGroupId);
    expect(assign.windowId).toBe(2);
  });

  it("keeps stale unmanaged group ungrouped when the hinted window survives", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const resolved = resolveUndoPlacement(
      {
        kind: "unmanagedGroup",
        chromeGroupIdHint: 77,
        windowIdHint: 1,
        index: 2
      },
      2,
      configuration,
      {
        windows: [{ id: 1, focused: false, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 1
      },
      []
    );
    expect(resolved).toEqual({
      kind: "ungrouped",
      windowId: 1,
      index: 2,
      degraded: true
    });
  });
});
