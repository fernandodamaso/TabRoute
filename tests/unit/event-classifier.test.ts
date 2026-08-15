import { describe, expect, it } from "vitest";
import { classifyChromeEvent } from "../../src/controller/eventClassifier";
import { createEmptyRuntimeSession } from "../../src/state/runtimeSession";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import type {
  BrowserSessionId,
  ChromeInventory,
  RuntimeSession
} from "../../src/domain/types";
import { GUARD_HARD_MS } from "../../src/actions/operationGuards";

const sessionId = "session-a" as BrowserSessionId;

function inventory(overrides: Partial<ChromeInventory> = {}): ChromeInventory {
  return {
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [
      {
        id: 7,
        windowId: 1,
        index: 0,
        chromeGroupId: -1,
        url: "https://example.com/",
        title: "Example",
        pinned: false,
        active: true,
        incognito: false,
        lastAccessed: 1
      }
    ],
    groups: [],
    capturedAt: 1,
    ...overrides
  };
}

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    ...createEmptyRuntimeSession({ browserSessionId: sessionId }),
    ...overrides
  };
}

describe("classifyChromeEvent", () => {
  it("ignores subjects missing from inventory", () => {
    const result = classifyChromeEvent(
      {
        kind: "tabUpdated",
        tabId: 99,
        urlChanged: true,
        groupChanged: false,
        pinnedChanged: false
      },
      inventory(),
      session(),
      100
    );
    expect(result.requests).toEqual([]);
    expect(result.guarded).toBe(false);
  });

  it("ignores events for tabs missing from inventory", () => {
    const result = classifyChromeEvent(
      {
        kind: "tabUpdated",
        tabId: 99,
        urlChanged: true,
        groupChanged: false,
        pinnedChanged: false
      },
      inventory({ tabs: [] }),
      session(),
      100
    );
    expect(result.requests).toEqual([]);
  });

  it("does not change lastFocusedNormalWindowId for WINDOW_ID_NONE focus", () => {
    const result = classifyChromeEvent(
      { kind: "windowFocusChanged", focus: { kind: "none" } },
      inventory(),
      session({ lastFocusedNormalWindowId: 1 }),
      100
    );
    expect(result.requests).toEqual([]);
    expect(result.session.lastFocusedNormalWindowId).toBe(1);
  });

  it("sets lastFocusedNormalWindowId for a normal window in inventory", () => {
    const result = classifyChromeEvent(
      { kind: "windowFocusChanged", focus: { kind: "normal", windowId: 1 } },
      inventory(),
      session(),
      100
    );
    expect(result.session.lastFocusedNormalWindowId).toBe(1);
  });

  it("transfers replaced tab state and requests reconciliation of added tab", () => {
    const result = classifyChromeEvent(
      { kind: "tabReplaced", addedTabId: 99, removedTabId: 7 },
      inventory({
        tabs: [
          {
            id: 99,
            windowId: 1,
            index: 0,
            chromeGroupId: -1,
            url: "https://example.com/",
            title: "Example",
            pinned: false,
            active: true,
            incognito: false,
            lastAccessed: 1
          }
        ]
      }),
      session({
        tabObservations: [
          {
            tabId: 7,
            firstObservedAt: 1,
            firstObservedOrdinal: 0,
            lastObservedUrl: "https://example.com/"
          }
        ]
      }),
      100
    );
    expect(result.session.tabObservations[0]?.tabId).toBe(99);
    expect(result.requests).toEqual([
      { scope: { kind: "tab", tabId: 99 }, reason: "tab-replaced" }
    ]);
  });

  it("defers guarded events without reconciliation requests", () => {
    const result = classifyChromeEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: true,
        pinnedChanged: false
      },
      inventory({
        tabs: [{ ...inventory().tabs[0]!, chromeGroupId: 11 }],
        groups: [
          {
            id: 11,
            windowId: 1,
            title: "Other",
            color: "grey",
            collapsed: false,
            shared: false
          }
        ]
      }),
      session({
        operationGuards: [
          {
            id: "00000000-0000-4000-8000-000000000010" as import("../../src/domain/types").UUID,
            browserSessionId: sessionId,
            actionId:
              "00000000-0000-4000-8000-000000000011" as import("../../src/domain/types").ActionId,
            operation: "assignTabsToManagedGroup",
            phase: "executing",
            tabIds: [7],
            chromeGroupIds: [11],
            expectedEventKinds: ["tabUpdated"],
            seenEventKinds: [],
            postcondition: {
              kind: "tabPlacement",
              tabIds: [7],
              windowId: 1,
              chromeGroupId: 11
            },
            startedAt: 1,
            expiresAt: 1 + GUARD_HARD_MS
          }
        ]
      }),
      100
    );
    expect(result.guarded).toBe(true);
    expect(result.deferred).toBe(true);
    expect(result.requests).toEqual([]);
  });

  it("holds loading tabs without routing requests", () => {
    const result = classifyChromeEvent(
      { kind: "tabCreated", tabId: 7 },
      inventory({
        tabs: [
          {
            id: 7,
            windowId: 1,
            index: 0,
            chromeGroupId: -1,
            url: undefined,
            status: "loading",
            title: "",
            pinned: false,
            active: true,
            incognito: false,
            lastAccessed: 1
          }
        ]
      }),
      session(),
      100
    );
    expect(result.requests).toEqual([]);
  });

  it("requests routing only after a committed URL arrives", () => {
    const loading = classifyChromeEvent(
      { kind: "tabCreated", tabId: 7 },
      inventory({
        tabs: [
          {
            id: 7,
            windowId: 1,
            index: 0,
            chromeGroupId: -1,
            url: undefined,
            status: "loading",
            title: "",
            pinned: false,
            active: true,
            incognito: false,
            lastAccessed: 1
          }
        ]
      }),
      session(),
      100
    );
    expect(loading.requests).toEqual([]);

    const committed = classifyChromeEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: true,
        groupChanged: false,
        pinnedChanged: false
      },
      inventory(),
      loading.session,
      200
    );
    expect(committed.requests).toEqual([
      { scope: { kind: "tab", tabId: 7 }, reason: "routable" }
    ]);
  });

  it("does not classify placement on tabUpdated with no meaningful changes", () => {
    const result = classifyChromeEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: false,
        pinnedChanged: false
      },
      inventory(),
      session(),
      100
    );
    expect(result.requests).toEqual([]);
    expect(result.manualOverride).toBeUndefined();
  });

  it("bumps observation recency on tabActivated without placement override", () => {
    const result = classifyChromeEvent(
      { kind: "tabActivated", tabId: 7, windowId: 1 },
      inventory(),
      session({
        tabObservations: [
          {
            tabId: 7,
            firstObservedAt: 1,
            firstObservedOrdinal: 0,
            lastObservedUrl: "https://example.com/"
          }
        ]
      }),
      100
    );
    expect(result.manualOverride).toBeUndefined();
    expect(result.requests).toEqual([]);
  });

  it("purges closed tabs when no guard or pending removal references them", () => {
    const result = classifyChromeEvent(
      {
        kind: "tabRemoved",
        tabId: 7,
        windowId: 1,
        isWindowClosing: false
      },
      inventory({ tabs: [] }),
      session({
        tabObservations: [
          {
            tabId: 7,
            firstObservedAt: 1,
            firstObservedOrdinal: 0,
            lastObservedUrl: "https://example.com/"
          }
        ]
      }),
      100
    );
    expect(result.session.tabObservations).toHaveLength(0);
  });

  it("starts pending group removal after groupRemoved even when group is gone from inventory", () => {
    const managedGroupId =
      "00000000-0000-4000-8000-000000000002" as import("../../src/domain/types").UUID;
    const result = classifyChromeEvent(
      {
        kind: "groupRemoved",
        group: {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      },
      inventory({ groups: [], tabs: [] }),
      session({
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: ["https://docs.example.com/"],
            observedAt: 1
          }
        ]
      }),
      100,
      createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001")
    );
    expect(result.session.pendingGroupRemovals).toHaveLength(1);
    expect(result.session.pendingGroupRemovals[0]?.memberUrls).toEqual([
      "https://docs.example.com/"
    ]);
  });

  it("reconciles all tabs after windowRemoved", () => {
    const result = classifyChromeEvent(
      { kind: "windowRemoved", windowId: 99 },
      inventory(),
      session(),
      100
    );
    expect(result.requests).toEqual([
      { scope: { kind: "all" }, reason: "window-removed" }
    ]);
  });

  it("settles pending group removals on alarm", () => {
    const managedGroupId =
      "00000000-0000-4000-8000-000000000002" as import("../../src/domain/types").UUID;
    const config = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const result = classifyChromeEvent(
      { kind: "alarm", name: "tabroute:group-settlement" },
      inventory({ groups: [], tabs: [] }),
      session({
        pendingGroupRemovals: [
          {
            managedGroupId,
            removedChromeGroupId: 11,
            oldWindowId: 1,
            memberTabIds: [],
            memberUrls: [],
            renderedTitle: "Docs",
            startedAt: 1,
            settleAfter: 100
          }
        ],
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: [],
            observedAt: 1
          }
        ]
      }),
      200,
      config
    );
    expect(result.session.pendingGroupRemovals).toHaveLength(0);
  });

  it("does not route shared-group members", () => {
    const result = classifyChromeEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: true,
        groupChanged: false,
        pinnedChanged: false
      },
      inventory({
        tabs: [{ ...inventory().tabs[0]!, chromeGroupId: 11 }],
        groups: [
          {
            id: 11,
            windowId: 1,
            title: "Shared",
            color: "grey",
            collapsed: false,
            shared: true
          }
        ]
      }),
      session(),
      100
    );
    expect(result.requests).toEqual([]);
  });
});
