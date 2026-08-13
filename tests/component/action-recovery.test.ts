import { describe, expect, it } from "vitest";
import {
  executeActionPlan,
  settleGuardsFromSession
} from "../../src/actions/executeActionPlan";
import { GUARD_HARD_MS, GUARD_QUIET_MS } from "../../src/actions/operationGuards";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import type {
  ChromeInventory,
  ChromeMutationPort,
  ChromeTabSnapshot
} from "../../src/chrome/types";

function tab(overrides: Partial<ChromeTabSnapshot> = {}): ChromeTabSnapshot {
  return {
    id: 7,
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

function fakePort(initial: ChromeInventory, options?: { failGroupTabs?: boolean }) {
  const inventory = structuredClone(initial);
  let groupCalls = 0;
  const port: ChromeMutationPort = {
    async readInventory() {
      return structuredClone(inventory);
    },
    async groupTabs(input) {
      groupCalls += 1;
      if (options?.failGroupTabs) throw new Error("groupTabs failed");
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
    async ungroupTabs(tabIds) {
      inventory.tabs = inventory.tabs.map((candidate) =>
        tabIds.includes(candidate.id)
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
  return { port, inventory, getGroupCalls: () => groupCalls };
}

describe("action recovery with operation guards", () => {
  it("writes an executing guard before groupTabs and a settling guard after verification", async () => {
    const now = 1000;
    const session = createMemorySessionRepository();
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab()],
      groups: [],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fallback = configuration.groups.find((group) => group.isFallback)!;

    await executeActionPlan(
      {
        kind: "routeToFallback",
        tab: tab(),
        managedGroupId: fallback.id,
        groupInput: { kind: "create", tabIds: [7], windowId: 1 },
        title: "Other",
        color: "grey"
      },
      {
        chrome: fake.port,
        session,
        now: () => now,
        createId: () =>
          "00000000-0000-4000-8000-000000000099" as import("../../src/domain/types").UUID
      }
    );

    const stored = await session.loadSession();
    expect(stored.operationGuards).toHaveLength(1);
    const guard = stored.operationGuards[0]!;
    expect(guard.phase).toBe("settling");
    expect(guard.verifiedAt).toBe(now);
    expect(guard.settleAfter).toBe(now + GUARD_QUIET_MS);
    expect(guard.expiresAt).toBe(now + GUARD_HARD_MS);
  });

  it("keeps the guard present after the executor returns", async () => {
    const session = createMemorySessionRepository();
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab()],
      groups: [],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fallback = configuration.groups.find((group) => group.isFallback)!;

    await executeActionPlan(
      {
        kind: "routeToFallback",
        tab: tab(),
        managedGroupId: fallback.id,
        groupInput: { kind: "create", tabIds: [7], windowId: 1 },
        title: "Other",
        color: "grey"
      },
      { chrome: fake.port, session, now: () => 1000 }
    );

    expect((await session.loadSession()).operationGuards).toHaveLength(1);
  });

  it("removes the executing guard when groupTabs throws", async () => {
    const session = createMemorySessionRepository();
    const fake = fakePort(
      {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [tab()],
        groups: [],
        capturedAt: 1
      },
      { failGroupTabs: true }
    );
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fallback = configuration.groups.find((group) => group.isFallback)!;

    await expect(
      executeActionPlan(
        {
          kind: "routeToFallback",
          tab: tab(),
          managedGroupId: fallback.id,
          groupInput: { kind: "create", tabIds: [7], windowId: 1 },
          title: "Other",
          color: "grey"
        },
        { chrome: fake.port, session, now: () => 1000 }
      )
    ).rejects.toThrow("groupTabs failed");

    expect((await session.loadSession()).operationGuards).toHaveLength(0);
  });

  it("settles guards from inventory without replaying mutations", async () => {
    const now = 1000;
    const session = createMemorySessionRepository();
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
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fallback = configuration.groups.find((group) => group.isFallback)!;

    await executeActionPlan(
      {
        kind: "routeToFallback",
        tab: tab(),
        managedGroupId: fallback.id,
        groupInput: { kind: "create", tabIds: [7], windowId: 1 },
        title: "Other",
        color: "grey"
      },
      {
        chrome: fake.port,
        session,
        now: () => now,
        createId: () =>
          "00000000-0000-4000-8000-000000000099" as import("../../src/domain/types").UUID
      }
    );

    const callsBefore = fake.getGroupCalls();
    await settleGuardsFromSession({
      chrome: fake.port,
      session,
      now: () => now + GUARD_QUIET_MS + 1
    });
    expect(fake.getGroupCalls()).toBe(callsBefore);
    expect((await session.loadSession()).operationGuards).toHaveLength(0);
  });
});
