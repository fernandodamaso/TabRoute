import { describe, expect, it } from "vitest";
import { identifyClosedSession } from "../../src/activity/identifyClosedSession";
import {
  deriveUndoPlacementFromTab,
  WINDOW_ID_NONE,
  planUndoActions
} from "../../src/activity/undoPlanner";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import type { UUID } from "../../src/domain/types";

describe("undo planner", () => {
  it("identifyClosedSession returns null for 0 and N matches", () => {
    const before = [{ sessionId: "a", url: "https://x.test/", title: "X", lastAccessed: 1 }];
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
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const workId = "00000000-0000-4000-8000-000000000002" as UUID;
    const inventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" as const }],
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
});
