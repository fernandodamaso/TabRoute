import { describe, expect, it } from "vitest";
import {
  GUARD_HARD_MS,
  GUARD_QUIET_MS,
  buildExpectedFootprint,
  classifyGuardedEvent,
  postconditionHolds,
  settleOperationGuards
} from "../../src/actions/operationGuards";
import { createEmptyRuntimeSession } from "../../src/state/runtimeSession";
import type {
  ActionId,
  BrowserSessionId,
  ChromeInventory,
  OperationGuard,
  RuntimeSession,
  UUID
} from "../../src/domain/types";
import type { RoutePlan } from "../../src/actions/types";

const sessionId = "session-a" as BrowserSessionId;
const actionId = "00000000-0000-4000-8000-000000000011" as ActionId;
const guardId = "00000000-0000-4000-8000-000000000010" as UUID;

function tab(
  overrides: Partial<ChromeInventory["tabs"][number]> = {}
): ChromeInventory["tabs"][number] {
  return {
    id: 7,
    windowId: 1,
    index: 0,
    chromeGroupId: 11,
    url: "https://example.com/",
    title: "Example",
    pinned: false,
    active: true,
    incognito: false,
    lastAccessed: 1,
    ...overrides
  };
}

function inventory(overrides: Partial<ChromeInventory> = {}): ChromeInventory {
  return {
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [tab()],
    groups: [
      {
        id: 11,
        windowId: 1,
        title: "Other",
        color: "grey",
        collapsed: false,
        shared: false
      }
    ],
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

function guard(overrides: Partial<OperationGuard> = {}): OperationGuard {
  return {
    id: guardId,
    browserSessionId: sessionId,
    actionId,
    operation: "assignTabsToManagedGroup",
    phase: "executing",
    tabIds: [7],
    chromeGroupIds: [11],
    expectedEventKinds: ["tabUpdated", "groupUpdated", "tabReplaced"],
    seenEventKinds: [],
    postcondition: {
      kind: "tabPlacement",
      tabIds: [7],
      windowId: 1,
      chromeGroupId: 11
    },
    startedAt: 1,
    expiresAt: 1 + GUARD_HARD_MS,
    ...overrides
  };
}

describe("buildExpectedFootprint", () => {
  it("builds assignTabsToManagedGroup footprint for routeToGroup with existing group", () => {
    const plan: RoutePlan = {
      kind: "routeToGroup",
      tab: tab({ chromeGroupId: -1 }),
      managedGroupId: "00000000-0000-4000-8000-000000000001" as UUID,
      groupInput: {
        kind: "existing",
        tabIds: [7],
        chromeGroupId: 11,
        windowId: 1
      },
      title: "Docs",
      color: "blue"
    };
    const footprint = buildExpectedFootprint(plan);
    expect(footprint.operation).toBe("assignTabsToManagedGroup");
    expect(footprint.tabIds).toEqual([7]);
    expect(footprint.expectedEventKinds).toContain("tabUpdated");
    expect(footprint.expectedEventKinds).toContain("groupUpdated");
    expect(footprint.postcondition).toEqual({
      kind: "tabPlacement",
      tabIds: [7],
      windowId: 1,
      chromeGroupId: 11
    });
  });

  it("builds assignTabsToManagedGroup footprint for routeToFallback creating a group", () => {
    const plan: RoutePlan = {
      kind: "routeToFallback",
      tab: tab({ chromeGroupId: -1 }),
      managedGroupId: "00000000-0000-4000-8000-000000000001" as UUID,
      groupInput: { kind: "create", tabIds: [7], windowId: 1 },
      title: "Other",
      color: "grey"
    };
    const footprint = buildExpectedFootprint(plan);
    expect(footprint.operation).toBe("assignTabsToManagedGroup");
    expect(footprint.expectedEventKinds).toContain("groupCreated");
    expect(footprint.postcondition).toEqual({
      kind: "tabPlacement",
      tabIds: [7],
      windowId: 1,
      grouped: true
    });
  });

  it("builds ungroupTabs footprint with groupRemoved and chromeGroupId", () => {
    const plan: RoutePlan = {
      kind: "ungroup",
      tab: tab({ chromeGroupId: 11 })
    };
    const footprint = buildExpectedFootprint(plan);
    expect(footprint.operation).toBe("ungroupTabs");
    expect(footprint.chromeGroupIds).toEqual([11]);
    expect(footprint.expectedEventKinds).toContain("groupRemoved");
    expect(footprint.postcondition).toEqual({
      kind: "tabPlacement",
      tabIds: [7],
      windowId: 1,
      ungrouped: true
    });
  });
});

describe("classifyGuardedEvent", () => {
  const inventoryWithTabInTarget = inventory();

  it("does not consume a guard on the first matching event", () => {
    const decision = classifyGuardedEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: true,
        pinnedChanged: false
      },
      inventoryWithTabInTarget,
      session({ operationGuards: [guard()] }),
      100
    );
    expect(decision.kind).toBe("defer");
    expect(
      decision.kind === "defer" && decision.session.operationGuards
    ).toHaveLength(1);
  });

  it("records seenEventKinds on defer without removing the guard", () => {
    const decision = classifyGuardedEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: true,
        pinnedChanged: false
      },
      inventoryWithTabInTarget,
      session({ operationGuards: [guard()] }),
      100
    );
    expect(decision.kind).toBe("defer");
    if (decision.kind === "defer") {
      expect(decision.guard.seenEventKinds).toContain("tabUpdated");
      expect(decision.session.operationGuards[0]?.phase).toBe("executing");
    }
  });

  it("returns echo during settling while postcondition still holds", () => {
    const settling = guard({
      phase: "settling",
      verifiedAt: 50,
      settleAfter: 800,
      seenEventKinds: ["tabUpdated"]
    });
    const decision = classifyGuardedEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: false,
        pinnedChanged: false
      },
      inventoryWithTabInTarget,
      session({ operationGuards: [settling] }),
      200
    );
    expect(decision.kind).toBe("echo");
    if (decision.kind === "echo") {
      expect(decision.guard.settleAfter).toBe(200 + GUARD_QUIET_MS);
      expect(decision.session.operationGuards).toHaveLength(1);
    }
  });

  it("returns manual and removes guard when inventory contradicts postcondition", () => {
    const settling = guard({
      phase: "settling",
      verifiedAt: 50,
      settleAfter: 800
    });
    const draggedAway = inventory({
      tabs: [tab({ chromeGroupId: 99 })],
      groups: [
        {
          id: 99,
          windowId: 1,
          title: "Native",
          color: "red",
          collapsed: false,
          shared: false
        }
      ]
    });
    const decision = classifyGuardedEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: true,
        pinnedChanged: false
      },
      draggedAway,
      session({ operationGuards: [settling] }),
      200
    );
    expect(decision.kind).toBe("manual");
    expect(
      decision.kind === "manual" && decision.session.operationGuards
    ).toHaveLength(0);
  });

  it("does not extend settleAfter past expiresAt", () => {
    const nearExpiry = guard({
      phase: "settling",
      verifiedAt: 4900,
      settleAfter: 4990,
      expiresAt: 5001,
      startedAt: 1
    });
    const decision = classifyGuardedEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: false,
        pinnedChanged: false
      },
      inventoryWithTabInTarget,
      session({ operationGuards: [nearExpiry] }),
      4980
    );
    expect(decision.kind).toBe("echo");
    if (decision.kind === "echo") {
      expect(decision.guard.settleAfter).toBe(5001);
    }
  });

  it("retires an expired guard when postcondition still holds before classifying", () => {
    const expired = guard({
      phase: "settling",
      verifiedAt: 1,
      settleAfter: 800,
      startedAt: 1,
      expiresAt: 5001
    });
    const decision = classifyGuardedEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: false,
        pinnedChanged: false
      },
      inventoryWithTabInTarget,
      session({ operationGuards: [expired] }),
      6000
    );
    expect(decision.kind).toBe("unmatched");
    expect(decision.session.operationGuards).toHaveLength(0);
  });

  it("returns manual for expired guard with contradictory inventory", () => {
    const expired = guard({
      phase: "settling",
      verifiedAt: 1,
      settleAfter: 800,
      startedAt: 1,
      expiresAt: 5001
    });
    const draggedAway = inventory({
      tabs: [tab({ chromeGroupId: 99 })],
      groups: [
        {
          id: 99,
          windowId: 1,
          title: "Native",
          color: "red",
          collapsed: false,
          shared: false
        }
      ]
    });
    const decision = classifyGuardedEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: true,
        pinnedChanged: false
      },
      draggedAway,
      session({ operationGuards: [expired] }),
      6000
    );
    expect(decision.kind).toBe("manual");
  });

  it("returns unmatched for events that do not match any guard", () => {
    const decision = classifyGuardedEvent(
      { kind: "tabCreated", tabId: 99 },
      inventory(),
      session({ operationGuards: [guard()] }),
      100
    );
    expect(decision.kind).toBe("unmatched");
  });

  it("ignores guards from a different browser session", () => {
    const otherSession = guard({
      browserSessionId: "other-session" as BrowserSessionId
    });
    const decision = classifyGuardedEvent(
      {
        kind: "tabUpdated",
        tabId: 7,
        urlChanged: false,
        groupChanged: true,
        pinnedChanged: false
      },
      inventoryWithTabInTarget,
      session({ operationGuards: [otherSession] }),
      100
    );
    expect(decision.kind).toBe("unmatched");
  });

  it("matches tabReplaced when added or removed tab id intersects guard subjects", () => {
    const decision = classifyGuardedEvent(
      { kind: "tabReplaced", addedTabId: 99, removedTabId: 7 },
      inventory({ tabs: [tab({ id: 99, chromeGroupId: 11 })] }),
      session({ operationGuards: [guard({ tabIds: [7] })] }),
      100
    );
    expect(decision.kind).toBe("defer");
  });
  it("binds tabCreated to pendingTab guard for create/restore actions before output tab ID exists", () => {
    const pendingGuard = guard({
      operation: "createTab",
      phase: "executing",
      tabIds: [],
      expectedEventKinds: ["tabCreated", "tabUpdated", "tabAttached"],
      postcondition: { kind: "tabsPresent", tabIds: [] },
      pendingTab: { url: "https://example.com/page", windowId: 1 }
    });

    const inv = inventory({
      tabs: [
        tab({
          id: 55,
          windowId: 1,
          url: "https://example.com/page",
          title: "Example Page"
        })
      ]
    });

    const decision = classifyGuardedEvent(
      { kind: "tabCreated", tabId: 55 },
      inv,
      session({ operationGuards: [pendingGuard] }),
      100
    );

    expect(decision.kind).toBe("defer");
    if (decision.kind === "defer") {
      expect(decision.guard.tabIds).toEqual([55]);
      expect(decision.guard.pendingTab).toBeUndefined();
      expect(decision.guard.postcondition).toEqual({
        kind: "tabsPresent",
        tabIds: [55]
      });
      expect(decision.guard.seenEventKinds).toContain("tabCreated");
    }
  });

  it("does not bind pendingTab if URL or windowId does not match", () => {
    const pendingGuard = guard({
      operation: "createTab",
      phase: "executing",
      tabIds: [],
      expectedEventKinds: ["tabCreated"],
      pendingTab: { url: "https://example.com/target", windowId: 1 }
    });

    const invOtherWindow = inventory({
      tabs: [tab({ id: 55, windowId: 2, url: "https://example.com/target" })]
    });

    const decisionOtherWindow = classifyGuardedEvent(
      { kind: "tabCreated", tabId: 55 },
      invOtherWindow,
      session({ operationGuards: [pendingGuard] }),
      100
    );
    expect(decisionOtherWindow.kind).toBe("unmatched");

    const invOtherUrl = inventory({
      tabs: [tab({ id: 56, windowId: 1, url: "https://different.com/" })]
    });
    const decisionOtherUrl = classifyGuardedEvent(
      { kind: "tabCreated", tabId: 56 },
      invOtherUrl,
      session({ operationGuards: [pendingGuard] }),
      100
    );
    expect(decisionOtherUrl.kind).toBe("unmatched");
  });

  it("binds only the first matching guard when two same-URL pending guards exist", () => {
    const firstGuard = guard({
      id: "00000000-0000-4000-8000-000000000001" as UUID,
      operation: "createTab",
      phase: "executing",
      tabIds: [],
      expectedEventKinds: ["tabCreated"],
      pendingTab: { url: "https://example.com/same", windowId: 1 }
    });
    const secondGuard = guard({
      id: "00000000-0000-4000-8000-000000000002" as UUID,
      operation: "createTab",
      phase: "executing",
      tabIds: [],
      expectedEventKinds: ["tabCreated"],
      pendingTab: { url: "https://example.com/same", windowId: 1 }
    });

    const inv = inventory({
      tabs: [tab({ id: 77, windowId: 1, url: "https://example.com/same" })]
    });

    const decision = classifyGuardedEvent(
      { kind: "tabCreated", tabId: 77 },
      inv,
      session({ operationGuards: [firstGuard, secondGuard] }),
      100
    );

    expect(decision.kind).toBe("defer");
    if (decision.kind === "defer") {
      expect(decision.guard.id).toBe(firstGuard.id);
      expect(decision.guard.tabIds).toEqual([77]);
      const remainingSecond = decision.session.operationGuards.find(
        (g) => g.id === secondGuard.id
      );
      expect(remainingSecond?.tabIds).toEqual([]);
      expect(remainingSecond?.pendingTab).toBeDefined();
    }
  });
});

describe("settleOperationGuards", () => {
  it("retires a quiet settling guard when postcondition holds", () => {
    const settling = guard({
      phase: "settling",
      verifiedAt: 100,
      settleAfter: 850,
      startedAt: 100,
      expiresAt: 5100
    });
    const next = settleOperationGuards(
      inventory(),
      session({ operationGuards: [settling] }),
      900
    );
    expect(next.operationGuards).toHaveLength(0);
  });

  it("retires a settling guard at hard deadline when postcondition holds", () => {
    const settling = guard({
      phase: "settling",
      verifiedAt: 100,
      settleAfter: 2000,
      startedAt: 100,
      expiresAt: 5100
    });
    const next = settleOperationGuards(
      inventory(),
      session({ operationGuards: [settling] }),
      5100
    );
    expect(next.operationGuards).toHaveLength(0);
  });

  it("retires an expired executing guard when postcondition holds", () => {
    const executing = guard({
      phase: "executing",
      startedAt: 100,
      expiresAt: 5100
    });
    const next = settleOperationGuards(
      inventory(),
      session({ operationGuards: [executing] }),
      6000
    );
    expect(next.operationGuards).toHaveLength(0);
  });

  it("drops an expired executing guard when postcondition no longer holds", () => {
    const executing = guard({
      phase: "executing",
      startedAt: 100,
      expiresAt: 5100
    });
    const next = settleOperationGuards(
      inventory({ tabs: [tab({ chromeGroupId: 99 })] }),
      session({ operationGuards: [executing] }),
      6000
    );
    expect(next.operationGuards).toHaveLength(0);
  });

  it("keeps an executing guard before hard deadline", () => {
    const executing = guard({
      phase: "executing",
      startedAt: 100,
      expiresAt: 5100
    });
    const next = settleOperationGuards(
      inventory(),
      session({ operationGuards: [executing] }),
      2000
    );
    expect(next.operationGuards).toHaveLength(1);
  });

  it("does not retire a settling guard before quiet period without postcondition satisfaction", () => {
    const settling = guard({
      phase: "settling",
      verifiedAt: 100,
      settleAfter: 2000,
      startedAt: 100,
      expiresAt: 5100
    });
    const next = settleOperationGuards(
      inventory({ tabs: [tab({ chromeGroupId: 99 })] }),
      session({ operationGuards: [settling] }),
      900
    );
    expect(next.operationGuards).toHaveLength(1);
  });
});

describe("postconditionHolds", () => {
  it("checks tab placement with chromeGroupId", () => {
    expect(
      postconditionHolds(
        { kind: "tabPlacement", tabIds: [7], windowId: 1, chromeGroupId: 11 },
        inventory()
      )
    ).toBe(true);
  });

  it("checks ungrouped placement", () => {
    expect(
      postconditionHolds(
        {
          kind: "tabPlacement",
          tabIds: [7],
          windowId: 1,
          ungrouped: true
        },
        inventory({ tabs: [tab({ chromeGroupId: -1 })], groups: [] })
      )
    ).toBe(true);
  });

  it("verifies managedGroupState postcondition against the exact intended native group", () => {
    const intendedGroupId = 20;
    const unrelatedGroupId = 30;
    const managedUuid = "00000000-0000-4000-8000-000000000001" as UUID;

    const invWithUnrelatedInWindow2 = inventory({
      groups: [
        {
          id: intendedGroupId,
          windowId: 1,
          title: "Old Title",
          color: "blue",
          collapsed: false,
          shared: false
        },
        {
          id: unrelatedGroupId,
          windowId: 2,
          title: "New Title",
          color: "red",
          collapsed: true,
          shared: false
        }
      ]
    });

    const postcondition = {
      kind: "managedGroupState" as const,
      managedGroupId: managedUuid,
      chromeGroupId: intendedGroupId,
      windowId: 2,
      title: "New Title",
      color: "red" as const,
      collapsed: true
    };

    // Verification must fail because intended group #20 is still in window 1 with Old Title
    expect(postconditionHolds(postcondition, invWithUnrelatedInWindow2)).toBe(
      false
    );

    // Once intended group #20 moves to window 2 and updates to New Title/red/collapsed, verification succeeds
    const invWithIntendedUpdated = inventory({
      groups: [
        {
          id: intendedGroupId,
          windowId: 2,
          title: "New Title",
          color: "red",
          collapsed: true,
          shared: false
        }
      ]
    });
    expect(postconditionHolds(postcondition, invWithIntendedUpdated)).toBe(
      true
    );
  });
});
