import { describe, expect, it } from "vitest";
import {
  executeRoutePlan,
  settleGuardsFromSession
} from "../../src/actions/executeRoutePlan";
import {
  GUARD_HARD_MS,
  GUARD_QUIET_MS
} from "../../src/actions/operationGuards";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import type { ChromeTabSnapshot } from "../../src/chrome/types";
import type { UUID } from "../../src/domain/types";

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

const checkpoints = {
  captureBefore: async () => undefined
};

describe("action recovery with operation guards", () => {
  it("writes an executing guard before groupTabs and a settling guard after verification", async () => {
    const now = 1000;
    const session = createMemorySessionRepository();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab()],
      groups: [],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fallback = configuration.groups.find((group) => group.isFallback)!;

    await executeRoutePlan(
      {
        kind: "routeToFallback",
        tab: tab(),
        managedGroupId: fallback.id,
        groupInput: { kind: "create", tabIds: [7], windowId: 1 },
        title: "Other",
        color: "grey"
      },
      {
        chrome: fake,
        session,
        checkpoints,
        now: () => now,
        createId: () => "00000000-0000-4000-8000-000000000099" as UUID
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
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab()],
      groups: [],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fallback = configuration.groups.find((group) => group.isFallback)!;

    await executeRoutePlan(
      {
        kind: "routeToFallback",
        tab: tab(),
        managedGroupId: fallback.id,
        groupInput: { kind: "create", tabIds: [7], windowId: 1 },
        title: "Other",
        color: "grey"
      },
      { chrome: fake, session, checkpoints, now: () => 1000 }
    );

    expect((await session.loadSession()).operationGuards).toHaveLength(1);
  });

  it("removes the executing guard when groupTabs throws", async () => {
    const session = createMemorySessionRepository();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab()],
      groups: [],
      capturedAt: 1
    });
    fake.setError("groupTabs", new Error("groupTabs failed"));
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fallback = configuration.groups.find((group) => group.isFallback)!;

    await expect(
      executeRoutePlan(
        {
          kind: "routeToFallback",
          tab: tab(),
          managedGroupId: fallback.id,
          groupInput: { kind: "create", tabIds: [7], windowId: 1 },
          title: "Other",
          color: "grey"
        },
        { chrome: fake, session, checkpoints, now: () => 1000 }
      )
    ).rejects.toThrow("groupTabs failed");

    expect((await session.loadSession()).operationGuards).toHaveLength(0);
  });

  it("settles guards from inventory without replaying mutations", async () => {
    const now = 1000;
    const session = createMemorySessionRepository();
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
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fallback = configuration.groups.find((group) => group.isFallback)!;

    await executeRoutePlan(
      {
        kind: "routeToFallback",
        tab: tab(),
        managedGroupId: fallback.id,
        groupInput: { kind: "create", tabIds: [7], windowId: 1 },
        title: "Other",
        color: "grey"
      },
      {
        chrome: fake,
        session,
        checkpoints,
        now: () => now,
        createId: () => "00000000-0000-4000-8000-000000000099" as UUID
      }
    );

    const callsBefore = fake.callsFor("groupTabs").length;
    await settleGuardsFromSession({
      chrome: fake,
      session,
      now: () => now + GUARD_QUIET_MS + 1
    });
    expect(fake.callsFor("groupTabs").length).toBe(callsBefore);
    expect((await session.loadSession()).operationGuards).toHaveLength(0);
  });

  it("retries an unchanged existing-group placement", async () => {
    const session = createMemorySessionRepository();
    const initial = tab({ chromeGroupId: -1 });
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [initial],
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
    let attempts = 0;
    const chrome = {
      ...fake,
      async groupTabs(input: Parameters<typeof fake.groupTabs>[0]) {
        attempts += 1;
        if (attempts === 1) throw new Error("Tabs cannot be edited right now");
        return fake.groupTabs(input);
      }
    };
    const result = await executeRoutePlan(
      {
        kind: "routeToGroup",
        tab: initial,
        managedGroupId: "00000000-0000-4000-8000-000000000001" as UUID,
        groupInput: {
          kind: "existing",
          tabIds: [initial.id],
          chromeGroupId: 11,
          windowId: 1
        },
        title: "Other",
        color: "grey"
      },
      { chrome, session, checkpoints, now: () => 1000 }
    );
    expect(result.kind).toBe("executed");
    expect(attempts).toBe(2);
  });

  it("recovers a create-group mutation that applied before throwing", async () => {
    const session = createMemorySessionRepository();
    const initial = tab();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [initial],
      groups: [],
      capturedAt: 1
    });
    let attempts = 0;
    const chrome = {
      ...fake,
      async groupTabs(input: Parameters<typeof fake.groupTabs>[0]) {
        attempts += 1;
        const groupId = await fake.groupTabs(input);
        if (attempts === 1) throw new Error("Tabs cannot be edited right now");
        return groupId;
      }
    };
    const result = await executeRoutePlan(
      {
        kind: "routeToGroup",
        tab: initial,
        managedGroupId: "00000000-0000-4000-8000-000000000001" as UUID,
        groupInput: { kind: "create", tabIds: [initial.id], windowId: 1 },
        title: "Work",
        color: "blue"
      },
      { chrome, session, checkpoints, now: () => 1000 }
    );
    expect(result.kind).toBe("executed");
    expect(attempts).toBe(1);
    expect(fake.getInventory().tabs[0]?.chromeGroupId).toBe(
      fake.getInventory().groups[0]?.id
    );
  });

  it("recovers an update-group mutation that applied before throwing", async () => {
    const session = createMemorySessionRepository();
    const initial = tab();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [initial],
      groups: [],
      capturedAt: 1
    });
    let attempts = 0;
    const chrome = {
      ...fake,
      async updateGroup(
        groupId: number,
        patch: Parameters<typeof fake.updateGroup>[1]
      ) {
        attempts += 1;
        await fake.updateGroup(groupId, patch);
        if (attempts === 1) throw new Error("Tabs cannot be edited right now");
      }
    };
    const result = await executeRoutePlan(
      {
        kind: "routeToGroup",
        tab: initial,
        managedGroupId: "00000000-0000-4000-8000-000000000001" as UUID,
        groupInput: { kind: "create", tabIds: [initial.id], windowId: 1 },
        title: "Work",
        color: "blue"
      },
      { chrome, session, checkpoints, now: () => 1000 }
    );
    expect(result.kind).toBe("executed");
    expect(attempts).toBe(1);
    expect(fake.getInventory().groups[0]?.title).toBe("Work");
  });

  it("retires a transient grouping retry after a fresh user ungroup", async () => {
    const session = createMemorySessionRepository();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab({ chromeGroupId: 10 })],
      groups: [
        {
          id: 10,
          windowId: 1,
          title: "Source",
          color: "blue",
          collapsed: false,
          shared: false
        },
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
    let attempts = 0;
    const chrome = {
      ...fake,
      async groupTabs(input: Parameters<typeof fake.groupTabs>[0]) {
        attempts += 1;
        if (attempts === 1) {
          fake.getStorage().inventory.tabs = fake
            .getStorage()
            .inventory.tabs.map((candidate) => ({
              ...candidate,
              chromeGroupId: 12
            }));
          throw new Error("Tabs cannot be edited right now");
        }
        return fake.groupTabs(input);
      }
    };
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const fallback = configuration.groups.find((group) => group.isFallback)!;
    await expect(
      executeRoutePlan(
        {
          kind: "routeToFallback",
          tab: tab({ chromeGroupId: 10 }),
          managedGroupId: fallback.id,
          groupInput: {
            kind: "existing",
            tabIds: [7],
            chromeGroupId: 11,
            windowId: 1
          },
          title: "Other",
          color: "grey"
        },
        { chrome, session, checkpoints, now: () => 1000 }
      )
    ).rejects.toThrow("postcondition contradicted");
    expect(attempts).toBe(1);
  });

  it("checkpoints automatic ungroup before creating a guard or mutating Chrome", async () => {
    const session = createMemorySessionRepository();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab({ chromeGroupId: 11 })],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Source",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    });
    const rejectingCheckpoints = {
      captureBefore: async () => {
        throw new Error("CHECKPOINT_CAPACITY");
      }
    };

    await expect(
      executeRoutePlan(
        { kind: "ungroup", tab: tab({ chromeGroupId: 11 }) },
        {
          chrome: fake,
          session,
          checkpoints: rejectingCheckpoints,
          now: () => 1000
        }
      )
    ).rejects.toThrow("CHECKPOINT_CAPACITY");
    expect(fake.callsFor("ungroupTabs")).toHaveLength(0);
    expect((await session.loadSession()).operationGuards).toHaveLength(0);
  });
});
