import { describe, expect, it } from "vitest";
import { identifyClosedSession } from "../../src/activity/identifyClosedSession";
import { WINDOW_ID_NONE, planUndoActions } from "../../src/activity/undoPlanner";
import { createDefaultConfiguration } from "../../src/domain/defaults";

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
});
