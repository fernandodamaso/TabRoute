import { describe, expect, it } from "vitest";
import {
  createEmptyRuntimeSession,
  parseRuntimeSession,
  purgeClosedTab,
  scrubRuntimeState,
  transferReplacedTab
} from "../../src/state/runtimeSession";
import type {
  BrowserSessionId,
  OperationGuard,
  RuntimeSession
} from "../../src/domain/types";

const sessionId = "session-a" as BrowserSessionId;

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    ...createEmptyRuntimeSession({ browserSessionId: sessionId }),
    ...overrides
  };
}

describe("runtime session identity", () => {
  it("reuses an existing browserSessionId and does not mint a new one from empty objects", () => {
    const parsed = parseRuntimeSession(
      { schemaVersion: 1, browserSessionId: sessionId, associations: [] },
      "other" as BrowserSessionId
    );
    expect(parsed.browserSessionId).toBe(sessionId);
  });
});

describe("tabs.onReplaced transfer", () => {
  it("moves observation, override, guard subjects, and pending member ids before reconciliation", () => {
    const guard: OperationGuard = {
      id: "00000000-0000-4000-8000-000000000010" as RuntimeSession["operationGuards"][number]["id"],
      browserSessionId: sessionId,
      actionId:
        "00000000-0000-4000-8000-000000000011" as OperationGuard["actionId"],
      operation: "assignTabsToManagedGroup",
      phase: "settling",
      tabIds: [7],
      chromeGroupIds: [11],
      expectedEventKinds: ["tabUpdated"],
      seenEventKinds: [],
      startedAt: 1,
      expiresAt: 5001
    };
    const next = transferReplacedTab(
      session({
        tabObservations: [
          {
            tabId: 7,
            firstObservedAt: 1,
            firstObservedOrdinal: 0,
            lastObservedUrl: "https://a.example/"
          }
        ],
        manualOverrides: {
          "7": { tabId: 7, placement: { kind: "ungrouped" }, createdAt: 1 }
        },
        operationGuards: [guard],
        pendingGroupRemovals: [
          {
            managedGroupId:
              "00000000-0000-4000-8000-000000000001" as RuntimeSession["intentionallyClosedGroupIds"][number],
            removedChromeGroupId: 11,
            oldWindowId: 1,
            memberTabIds: [7],
            memberUrls: ["https://a.example/"],
            renderedTitle: "Other",
            startedAt: 1,
            settleAfter: 751
          }
        ]
      }),
      7,
      99
    );
    expect(next.tabObservations[0]?.tabId).toBe(99);
    expect(next.tabObservations[0]?.firstObservedOrdinal).toBe(0);
    expect(next.manualOverrides["99"]?.placement).toEqual({
      kind: "ungrouped"
    });
    expect(next.manualOverrides["7"]).toBeUndefined();
    expect(next.operationGuards[0]?.tabIds).toEqual([99]);
    expect(next.pendingGroupRemovals[0]?.memberTabIds).toEqual([99]);
  });
});

describe("ordinary removal and worker-wake scrub", () => {
  it("purges a closed tab only when no guard or pending removal still references it", () => {
    const guarded = session({
      tabObservations: [
        {
          tabId: 7,
          firstObservedAt: 1,
          firstObservedOrdinal: 0,
          lastObservedUrl: "https://a.example/"
        }
      ],
      operationGuards: [
        {
          id: "00000000-0000-4000-8000-000000000010" as OperationGuard["id"],
          browserSessionId: sessionId,
          actionId:
            "00000000-0000-4000-8000-000000000011" as OperationGuard["actionId"],
          operation: "ungroupTabs",
          phase: "executing",
          tabIds: [7],
          chromeGroupIds: [],
          expectedEventKinds: ["tabUpdated"],
          seenEventKinds: [],
          startedAt: 1,
          expiresAt: 5001
        }
      ]
    });
    expect(purgeClosedTab(guarded, 7).tabObservations).toHaveLength(1);
    expect(
      purgeClosedTab(
        session({
          tabObservations: [
            {
              tabId: 7,
              firstObservedAt: 1,
              firstObservedOrdinal: 0,
              lastObservedUrl: "https://a.example/"
            }
          ],
          manualOverrides: {
            "7": { tabId: 7, placement: { kind: "ungrouped" }, createdAt: 1 }
          }
        }),
        7
      ).tabObservations
    ).toEqual([]);
  });

  it("scrubs stale tab and group runtime ids against fresh inventory", () => {
    const next = scrubRuntimeState(
      session({
        lastFocusedNormalWindowId: 1,
        operationGuards: [
          {
            id: "00000000-0000-4000-8000-000000000010" as OperationGuard["id"],
            browserSessionId: sessionId,
            actionId:
              "00000000-0000-4000-8000-000000000011" as OperationGuard["actionId"],
            operation: "assignTabsToManagedGroup",
            phase: "settling",
            tabIds: [7, 8],
            chromeGroupIds: [11, 12],
            expectedEventKinds: ["tabUpdated"],
            seenEventKinds: [],
            startedAt: 1,
            expiresAt: 5001
          }
        ],
        associations: [
          {
            managedGroupId:
              "00000000-0000-4000-8000-000000000001" as RuntimeSession["intentionallyClosedGroupIds"][number],
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Other",
            observedMemberUrls: [],
            observedAt: 1
          }
        ]
      }),
      {
        windows: [{ id: 2, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 8,
            windowId: 2,
            index: 0,
            chromeGroupId: -1,
            url: "https://a.example/",
            title: "A",
            pinned: false,
            active: true,
            incognito: false,
            lastAccessed: 1
          }
        ],
        groups: [],
        capturedAt: 2
      }
    );
    expect(next.lastFocusedNormalWindowId).toBeUndefined();
    expect(next.operationGuards[0]?.tabIds).toEqual([8]);
    expect(next.operationGuards[0]?.chromeGroupIds).toEqual([]);
    expect(next.associations).toEqual([]);
  });
});
