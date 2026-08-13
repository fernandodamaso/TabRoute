import { describe, expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createTabRouteController } from "../../src/controller/controller";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { GUARD_HARD_MS, GUARD_QUIET_MS } from "../../src/actions/operationGuards";
import type {
  ChromeInventory,
  ChromeMutationPort,
  ChromeTabSnapshot
} from "../../src/chrome/types";
import type { BrowserSessionId, OperationGuard, UUID } from "../../src/domain/types";

function tab(overrides: Partial<ChromeTabSnapshot> = {}): ChromeTabSnapshot {
  return {
    id: 42,
    windowId: 1,
    index: 0,
    chromeGroupId: -1,
    url: "https://example.com/",
    status: "complete",
    title: "Example",
    pinned: false,
    active: true,
    incognito: false,
    lastAccessed: 1,
    ...overrides
  };
}

function fakePort(initial: ChromeInventory) {
  const inventory = structuredClone(initial);
  let groupCalls = 0;
  const port: ChromeMutationPort = {
    async readInventory() {
      return structuredClone(inventory);
    },
    async groupTabs(input) {
      groupCalls += 1;
      const id = input.kind === "create" ? 11 : input.chromeGroupId;
      inventory.groups = [
        ...inventory.groups.filter((group) => group.id !== id),
        {
          id,
          windowId: input.windowId,
          title: "",
          color: "grey" as const,
          collapsed: false,
          shared: false
        }
      ];
      inventory.tabs = inventory.tabs.map((candidate) =>
        input.tabIds.includes(candidate.id)
          ? { ...candidate, chromeGroupId: id }
          : candidate
      );
      return id;
    },
    async ungroupTabs(ids) {
      inventory.tabs = inventory.tabs.map((candidate) =>
        ids.includes(candidate.id)
          ? { ...candidate, chromeGroupId: -1 }
          : candidate
      );
    },
    async moveTabs() {},
    async updateGroup(groupId, patch) {
      inventory.groups = inventory.groups.map((group) =>
        group.id === groupId ? { ...group, ...patch } : group
      );
    }
  };
  return {
    port,
    inventory,
    getGroupCalls: () => groupCalls
  };
}

describe("controller lifecycle", () => {
  it("coalesces two tabUpdated events for the same tab into one groupTabs", async () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab()],
      groups: [],
      capturedAt: 1
    });
    const controller = createTabRouteController({
      configuration,
      chrome: fake.port,
      session: createMemorySessionRepository(),
      now: () => 1000
    });

    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: 42,
      urlChanged: true,
      groupChanged: false,
      pinnedChanged: false
    });
    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: 42,
      urlChanged: false,
      groupChanged: false,
      pinnedChanged: false
    });

    expect(fake.getGroupCalls()).toBe(1);
  });

  it("does not write manualOverrides during extension routeToGroup echoes", async () => {
    const now = 1000;
    const session = createMemorySessionRepository();
    const sessionId = (await session.loadSession()).browserSessionId;
    const guard: OperationGuard = {
      id: "00000000-0000-4000-8000-000000000010" as UUID,
      browserSessionId: sessionId,
      actionId: "00000000-0000-4000-8000-000000000011" as BrowserSessionId as OperationGuard["actionId"],
      operation: "assignTabsToManagedGroup",
      phase: "settling",
      tabIds: [42],
      chromeGroupIds: [11],
      expectedEventKinds: ["tabUpdated", "groupCreated"],
      seenEventKinds: ["groupCreated"],
      postcondition: {
        kind: "tabPlacement",
        tabIds: [42],
        windowId: 1,
        chromeGroupId: 11
      },
      startedAt: now,
      verifiedAt: now,
      settleAfter: now + GUARD_QUIET_MS,
      expiresAt: now + GUARD_HARD_MS
    };
    await session.saveSession({
      ...(await session.loadSession()),
      operationGuards: [guard]
    });
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab({ chromeGroupId: 11 })],
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
      capturedAt: 1
    });
    const controller = createTabRouteController({
      configuration,
      chrome: fake.port,
      session,
      now: () => now + 10
    });

    await controller.handleChromeEvent({
      kind: "groupCreated",
      group: fake.inventory.groups[0]!
    });
    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: 42,
      urlChanged: false,
      groupChanged: true,
      pinnedChanged: false
    });

    expect(Object.keys((await session.loadSession()).manualOverrides)).toEqual([]);
  });

  it("writes a manual override when user drags during settling without compensating", async () => {
    const now = 1000;
    const session = createMemorySessionRepository();
    const sessionId = (await session.loadSession()).browserSessionId;
    const guard: OperationGuard = {
      id: "00000000-0000-4000-8000-000000000010" as UUID,
      browserSessionId: sessionId,
      actionId: "00000000-0000-4000-8000-000000000011" as OperationGuard["actionId"],
      operation: "assignTabsToManagedGroup",
      phase: "settling",
      tabIds: [42],
      chromeGroupIds: [11],
      expectedEventKinds: ["tabUpdated"],
      seenEventKinds: [],
      postcondition: {
        kind: "tabPlacement",
        tabIds: [42],
        windowId: 1,
        chromeGroupId: 11
      },
      startedAt: now,
      verifiedAt: now,
      settleAfter: now + GUARD_QUIET_MS,
      expiresAt: now + GUARD_HARD_MS
    };
    await session.saveSession({
      ...(await session.loadSession()),
      operationGuards: [guard]
    });
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
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
      ],
      capturedAt: 1
    });
    const controller = createTabRouteController({
      configuration,
      chrome: fake.port,
      session,
      now: () => now + 10
    });

    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: 42,
      urlChanged: false,
      groupChanged: true,
      pinnedChanged: false
    });

    expect((await session.loadSession()).manualOverrides["42"]).toBeDefined();
    expect(fake.getGroupCalls()).toBe(0);
  });

  it("onWorkerWake settles guards without duplicating groupTabs", async () => {
    const now = 1000;
    const session = createMemorySessionRepository();
    const sessionId = (await session.loadSession()).browserSessionId;
    await session.saveSession({
      ...(await session.loadSession()),
      operationGuards: [
        {
          id: "00000000-0000-4000-8000-000000000010" as UUID,
          browserSessionId: sessionId,
          actionId: "00000000-0000-4000-8000-000000000011" as OperationGuard["actionId"],
          operation: "assignTabsToManagedGroup",
          phase: "executing",
          tabIds: [42],
          chromeGroupIds: [],
          expectedEventKinds: ["tabUpdated"],
          seenEventKinds: [],
          postcondition: {
            kind: "tabPlacement",
            tabIds: [42],
            windowId: 1
          },
          startedAt: now,
          expiresAt: now + GUARD_HARD_MS
        }
      ]
    });
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab({ chromeGroupId: 11 })],
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
      capturedAt: 1
    });
    const first = createTabRouteController({
      configuration,
      chrome: fake.port,
      session,
      now: () => now
    });
    const second = createTabRouteController({
      configuration,
      chrome: fake.port,
      session,
      now: () => now + GUARD_QUIET_MS + 1
    });

    await first.onWorkerWake();
    const callsAfterWake = fake.getGroupCalls();
    await second.onWorkerWake();
    expect(fake.getGroupCalls()).toBe(callsAfterWake);
  });

  it("routes a loading tab at most once after committed URL", async () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab({ url: undefined, status: "loading" })],
      groups: [],
      capturedAt: 1
    });
    const controller = createTabRouteController({
      configuration,
      chrome: fake.port,
      session: createMemorySessionRepository(),
      now: () => 1000
    });

    await controller.handleTabUpdated(tab({ url: undefined, status: "loading" }));
    expect(fake.getGroupCalls()).toBe(0);

    fake.inventory.tabs = [tab()];
    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: 42,
      urlChanged: true,
      groupChanged: false,
      pinnedChanged: false
    });
    expect(fake.getGroupCalls()).toBe(1);

    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: 42,
      urlChanged: false,
      groupChanged: false,
      pinnedChanged: false
    });
    expect(fake.getGroupCalls()).toBe(1);
  });
});
