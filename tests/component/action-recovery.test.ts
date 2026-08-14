import { describe, expect, it } from "vitest";
import {
  executeRoutePlan,
  settleGuardsFromSession
} from "../../src/actions/executeRoutePlan";
import { GUARD_HARD_MS, GUARD_QUIET_MS } from "../../src/actions/operationGuards";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import type { ChromeTabSnapshot } from "../../src/chrome/types";

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
      { chrome: fake, session, now: () => 1000 }
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
        { chrome: fake, session, now: () => 1000 }
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
        now: () => now,
        createId: () =>
          "00000000-0000-4000-8000-000000000099" as import("../../src/domain/types").UUID
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
  it("retires a transient grouping retry after a fresh user ungroup", async () => {
    const session = createMemorySessionRepository();
    const fake = createFakeChromePort({
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
              chromeGroupId: -1
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
          tab: tab(),
          managedGroupId: fallback.id,
          groupInput: { kind: "existing", tabIds: [7], chromeGroupId: 11, windowId: 1 },
          title: "Other",
          color: "grey"
        },
        { chrome, session, now: () => 1000 }
      )
    ).rejects.toThrow("postcondition contradicted");
    expect(attempts).toBe(1);
  });
});
