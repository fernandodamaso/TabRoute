import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { resolveDuplicate } from "../../src/duplicates/resolveDuplicate";
import { observeInventory } from "../../src/duplicates/observations";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import { createTestController } from "../helpers/controllerPersistence";
import type { ChromeTabSnapshot, Configuration, TabSnapshot, UUID } from "../../src/domain/types";

const groupId = "00000000-0000-4000-8000-000000000002" as UUID;
const fallbackId = "00000000-0000-4000-8000-000000000001";

function duplicateConfiguration(): Configuration {
  return {
    ...createDefaultConfiguration(() => fallbackId),
    duplicateSettings: {
      ...createDefaultConfiguration(() => fallbackId).duplicateSettings,
      globalPolicy: { kind: "exactUrl" as const }
    }
  };
}

function routableTab(id: number, overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    id,
    windowId: 1,
    index: id,
    chromeGroupId: -1,
    url: "https://example.com/page",
    status: "complete",
    title: "Example",
    pinned: false,
    active: false,
    incognito: false,
    lastAccessed: id,
    routing: { kind: "routable", url: "https://example.com/page" },
    ...overrides
  };
}

function chromeTab(id: number, overrides: Partial<ChromeTabSnapshot> = {}): ChromeTabSnapshot {
  return {
    id,
    windowId: overrides.windowId ?? 1,
    index: overrides.index ?? id,
    chromeGroupId: overrides.chromeGroupId ?? -1,
    url: "https://example.com/page",
    status: "complete",
    title: overrides.title ?? "Example",
    pinned: false,
    active: false,
    incognito: false,
    lastAccessed: overrides.lastAccessed ?? id,
    ...overrides
  };
}

describe("controller duplicates", () => {
  it("allow policy leaves both tabs without a duplicate decision", async () => {
    const configuration = createDefaultConfiguration(() => fallbackId);
    const sessionRepo = createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    const inventory = observeInventory(
      {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 1,
            windowId: 1,
            index: 0,
            chromeGroupId: -1,
            url: "https://example.com/page",
            title: "A",
            pinned: false,
            active: true,
            incognito: false,
            lastAccessed: 1
          },
          {
            id: 2,
            windowId: 1,
            index: 1,
            chromeGroupId: -1,
            url: "https://example.com/page",
            title: "B",
            pinned: false,
            active: false,
            incognito: false,
            lastAccessed: 2
          }
        ],
        groups: [],
        capturedAt: 1
      },
      session
    ).inventory;
    const decision = resolveDuplicate({
      inventory,
      tabs: inventory.tabs,
      configuration,
      associations: [],
      session,
      rule: null,
      destination: groupId,
      destinationManaged: true,
      destinationGroup: configuration.groups[0] ?? null
    });
    expect(decision).toBeNull();
  });

  it("selects one survivor for duplicate candidates", async () => {
    const configuration = duplicateConfiguration();
    const sessionRepo = createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    const tabs = [routableTab(1, { lastAccessed: 1 }), routableTab(2, { lastAccessed: 3 })];
    const inventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" as const }],
      tabs,
      groups: [],
      capturedAt: 1
    };
    const decision = resolveDuplicate({
      inventory,
      tabs,
      configuration,
      associations: [],
      session,
      rule: null,
      destination: "ungrouped",
      destinationManaged: false,
      destinationGroup: null
    });
    expect(decision?.survivor.id).toBe(2);
    expect(decision?.duplicatesToClose.map((tab) => tab.id)).toEqual([1]);
  });

  it("executes move survivor, focus, checkpoint, and closeDuplicate in order", async () => {
    const base = duplicateConfiguration();
    const workId = groupId;
    const configuration: Configuration = {
      ...base,
      rules: [
        {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000010" as UUID,
          targetGroupId: workId,
          priority: 10,
          positive: {
            kind: "host",
            operator: "exact",
            value: "example.com"
          },
          negative: [],
          actions: [{ kind: "group" }],
          enabled: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    };
    const local = createMemoryLocalRepository();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        chromeTab(1, { lastAccessed: 3, chromeGroupId: 10 }),
        chromeTab(2, { lastAccessed: 1, chromeGroupId: -1 })
      ],
      groups: [
        {
          id: 10,
          windowId: 1,
          title: "Wrong",
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
      local,
      now: () => 1000
    });

    await controller.handleTabUpdated(chromeTab(2, { lastAccessed: 1 }));

    const order = fake.callOrder();
    const groupIndex = order.indexOf("groupTabs");
    const focusIndex = order.indexOf("focusTab");
    const removeIndex = order.indexOf("removeTabs");
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    expect(focusIndex).toBeGreaterThan(groupIndex);
    expect(removeIndex).toBeGreaterThan(focusIndex);
    expect(fake.getInventory().tabs.map((tab) => tab.id)).toEqual([1]);
    const activity = await local.listActivity(undefined, 10);
    expect(activity[0]?.action).toBe("Closed duplicate");
    expect(activity[0]?.undoId).toBeTruthy();
  });

  it("never closes a shared-group duplicate", async () => {
    const configuration = duplicateConfiguration();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        chromeTab(1, { lastAccessed: 2 }),
        chromeTab(2, { lastAccessed: 1, chromeGroupId: 99 })
      ],
      groups: [
        {
          id: 99,
          windowId: 1,
          title: "Shared",
          color: "grey",
          collapsed: false,
          shared: true
        }
      ],
      capturedAt: 1
    });
    const controller = createTestController({ configuration, chrome: fake, now: () => 1000 });

    await controller.handleTabUpdated(chromeTab(1, { lastAccessed: 2 }));
    await controller.handleTabUpdated(chromeTab(2, { lastAccessed: 1, chromeGroupId: 99 }));

    expect(fake.callsFor("removeTabs")).toEqual([]);
    expect(fake.getInventory().tabs).toHaveLength(2);
  });

  it("suppresses duplicate closure when leaveWherePlaced is set", async () => {
    const configuration = duplicateConfiguration();
    const session = createMemorySessionRepository();
    const runtime = await session.loadSession();
    await session.saveSession({
      ...runtime,
      manualOverrides: {
        "2": {
          tabId: 2,
          placement: { kind: "leaveWherePlaced" },
          createdAt: 1
        }
      }
    });
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [chromeTab(1, { lastAccessed: 1 }), chromeTab(2, { lastAccessed: 3 })],
      groups: [],
      capturedAt: 1
    });
    const controller = createTestController({
      configuration,
      chrome: fake,
      session,
      now: () => 1000
    });

    await controller.handleTabUpdated(chromeTab(2, { lastAccessed: 3 }));
    expect(fake.callsFor("removeTabs")).toEqual([]);
    expect(fake.getInventory().tabs).toHaveLength(2);
  });

  it("closes one duplicate across windows and keeps a single survivor", async () => {
    const configuration = duplicateConfiguration();
    const fake = createFakeChromePort({
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" },
        { id: 2, focused: false, incognito: false, type: "normal" }
      ],
      tabs: [
        chromeTab(1, { windowId: 1, lastAccessed: 1 }),
        chromeTab(2, { windowId: 2, lastAccessed: 4 })
      ],
      groups: [],
      capturedAt: 1
    });
    const controller = createTestController({ configuration, chrome: fake, now: () => 1000 });

    await controller.handleTabUpdated(chromeTab(2, { windowId: 2, lastAccessed: 4 }));

    expect(fake.getInventory().tabs.map((tab) => tab.id)).toEqual([2]);
    expect(fake.callsFor("removeTabs")).toEqual([[ [1] ]]);
  });

  it("does not remove the survivor when duplicate close fails", async () => {
    const configuration = duplicateConfiguration();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [chromeTab(1, { lastAccessed: 1 }), chromeTab(2, { lastAccessed: 3 })],
      groups: [],
      capturedAt: 1
    });
    fake.setError("removeTabs", new Error("close failed"));
    const controller = createTestController({ configuration, chrome: fake, now: () => 1000 });

    await controller.handleTabUpdated(chromeTab(2, { lastAccessed: 3 }));

    expect(fake.getInventory().tabs.map((tab) => tab.id).sort()).toEqual([1, 2]);
  });
});
