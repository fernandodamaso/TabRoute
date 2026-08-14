import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createTestController } from "../helpers/controllerPersistence";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { GUARD_HARD_MS, GUARD_QUIET_MS } from "../../src/actions/operationGuards";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import type { ChromeTabSnapshot } from "../../src/chrome/types";
import type { OperationGuard, UUID } from "../../src/domain/types";

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

describe("controller lifecycle", () => {
  it("coalesces two tabUpdated events for the same tab into one groupTabs", async () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab()],
      groups: [],
      capturedAt: 1
    });
    const controller = createTestController({
      configuration,
      chrome: fake,
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

    expect(fake.callsFor("groupTabs").length).toBe(1);
  });

  it("does not write manualOverrides during extension routeToGroup echoes", async () => {
    const now = 1000;
    const session = createMemorySessionRepository();
    const sessionId = (await session.loadSession()).browserSessionId;
    const guard: OperationGuard = {
      id: "00000000-0000-4000-8000-000000000010" as UUID,
      browserSessionId: sessionId,
      actionId:
        "00000000-0000-4000-8000-000000000011" as import("../../src/domain/types").ActionId,
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
    const fake = createFakeChromePort({
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
    const controller = createTestController({
      configuration,
      chrome: fake,
      session,
      now: () => now + 10
    });

    await controller.handleChromeEvent({
      kind: "groupCreated",
      group: fake.getInventory().groups[0]!
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
    const fake = createFakeChromePort({
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
    const controller = createTestController({
      configuration,
      chrome: fake,
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
    expect(fake.callsFor("groupTabs").length).toBe(0);
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
    const fake = createFakeChromePort({
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
    const first = createTestController({
      configuration,
      chrome: fake,
      session,
      now: () => now
    });
    const second = createTestController({
      configuration,
      chrome: fake,
      session,
      now: () => now + GUARD_QUIET_MS + 1
    });

    await first.onWorkerWake();
    const callsAfterWake = fake.callsFor("groupTabs").length;
    await second.onWorkerWake();
    expect(fake.callsFor("groupTabs").length).toBe(callsAfterWake);
  });

  it("routes a loading tab at most once after committed URL", async () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab({ url: undefined, status: "loading" })],
      groups: [],
      capturedAt: 1
    });
    const controller = createTestController({
      configuration,
      chrome: fake,
      session: createMemorySessionRepository(),
      now: () => 1000
    });

    await controller.handleTabUpdated(tab({ url: undefined, status: "loading" }));
    expect(fake.callsFor("groupTabs").length).toBe(0);

    fake.getStorage().inventory.tabs = [tab()];
    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: 42,
      urlChanged: true,
      groupChanged: false,
      pinnedChanged: false
    });
    expect(fake.callsFor("groupTabs").length).toBe(1);

    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: 42,
      urlChanged: false,
      groupChanged: false,
      pinnedChanged: false
    });
    expect(fake.callsFor("groupTabs").length).toBe(1);
  });
});
  it("persists a rule-driven target definition exactly once before routing", async () => {
    const base = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const targetGroup = base.groups.find((group) => group.isFallback)!;
    const configuration = {
      ...base,
      duplicateSettings: {
        ...base.duplicateSettings,
        trackingParameters: ["utm_source"]
      },
      rules: [
        {
          schemaVersion: 1 as const,
          id: "00000000-0000-4000-8000-000000000010" as UUID,
          targetGroupId: targetGroup.id,
          priority: 10,
          positive: {
            kind: "host" as const,
            operator: "exact" as const,
            value: "docs.example"
          },
          negative: [],
          actions: [{ kind: "group" as const }, { kind: "makePersistent" as const }],
          enabled: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    };
    const currentTab = tab({
      url: "https://docs.example/guide#section?utm_source=x"
    });
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [currentTab],
      groups: [],
      capturedAt: 1
    });
    const persisted: typeof configuration[] = [];
    const controller = createTestController({
      configuration,
      chrome: fake,
      now: () => 1000,
      persistConfiguration: async (next) => {
        persisted.push(next as typeof configuration);
      }
    });
    await controller.handleTabUpdated(currentTab);
    await controller.handleTabUpdated(currentTab);
    expect(persisted).toHaveLength(1);
    expect(
      persisted[0]!.persistentTabs.filter(
        (persistent) => persistent.managedGroupId === targetGroup.id
      )
    ).toHaveLength(1);
    expect(persisted[0]!.persistentTabs[0]?.canonicalUrl).toBe(
      "https://docs.example/guide"
    );
  });
