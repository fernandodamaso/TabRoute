import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createTabRouteController } from "../../src/controller/controller";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import type {
  ChromeInventory,
  ChromeMutationPort,
  ChromeTabSnapshot
} from "../../src/chrome/types";
import type { Configuration, UUID } from "../../src/domain/types";

const docsId = "00000000-0000-4000-8000-000000000002" as UUID;

function tab(overrides: Partial<ChromeTabSnapshot> = {}): ChromeTabSnapshot {
  return {
    id: 7,
    windowId: 1,
    index: 0,
    chromeGroupId: -1,
    url: "https://docs.example.com/guide",
    status: "complete",
    title: "Guide",
    pinned: false,
    active: true,
    incognito: false,
    lastAccessed: 1,
    ...overrides
  };
}

function fakePort(initial: ChromeInventory) {
  const inventory = structuredClone(initial) as ChromeInventory & {
    groups: ChromeInventory["groups"][number][];
  };
  const calls: string[] = [];
  const port: ChromeMutationPort = {
    async readInventory() {
      return structuredClone(inventory);
    },
    async groupTabs(input) {
      calls.push(input.kind === "create" ? "create-group" : "reuse-group");
      const id = input.kind === "create" ? 11 : input.chromeGroupId;
      if (!inventory.groups.some((group) => group.id === id)) {
        inventory.groups.push({
          id,
          windowId: input.windowId,
          title: "",
          color: "grey",
          collapsed: false,
          shared: false
        });
      }
      inventory.tabs = inventory.tabs.map((candidate) =>
        input.tabIds.includes(candidate.id)
          ? { ...candidate, chromeGroupId: id }
          : candidate
      );
      return id;
    },
    async ungroupTabs(ids) {
      calls.push("ungroup-tabs");
      inventory.tabs = inventory.tabs.map((candidate) =>
        ids.includes(candidate.id)
          ? { ...candidate, chromeGroupId: -1 }
          : candidate
      );
    },
    async moveTabs() {
      calls.push("move-tabs");
    },
    async updateGroup(groupId, patch) {
      calls.push("update-group");
      inventory.groups = inventory.groups.map((group) =>
        group.id === groupId ? { ...group, ...patch } : group
      );
    }
  };
  return {
    port,
    calls,
    mutationsFor(tabId: number) {
      return calls.filter((_, index) => index >= 0 && inventory.tabs.some((t) => t.id === tabId));
    },
    inventory,
    setTabGroup(tabId: number, chromeGroupId: number) {
      inventory.tabs = inventory.tabs.map((candidate) =>
        candidate.id === tabId ? { ...candidate, chromeGroupId } : candidate
      );
    },
    addGroup(group: ChromeInventory["groups"][number]) {
      inventory.groups.push(group);
    }
  };
}

function docsConfiguration(): Configuration {
  const base = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  return {
    ...base,
    groups: [
      ...base.groups,
      {
        schemaVersion: 1,
        id: docsId,
        name: "Docs",
        color: "blue",
        isFallback: false,
        enabled: true,
        isPersistent: false,
        defaultOrder: 1,
        defaultCollapsed: false,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    rules: [
      {
        schemaVersion: 1,
        id: "00000000-0000-4000-8000-000000000010" as UUID,
        targetGroupId: docsId,
        priority: 10,
        positive: {
          kind: "host",
          operator: "exact",
          value: "docs.example.com"
        },
        negative: [],
        actions: [{ kind: "group" }],
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  };
}

describe("session overrides", () => {
  it("keeps a manual destination through rule changes until restart", async () => {
    const configuration = docsConfiguration();
    const current = tab();
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [current],
      groups: [],
      capturedAt: 1
    });
    const controller = createTabRouteController({
      configuration,
      chrome: fake.port,
      session: createMemorySessionRepository()
    });

    await controller.handleChromeEvent({
      kind: "tabAttached",
      tabId: current.id,
      newWindowId: 1,
      newPosition: 2
    });

    const edited = {
      ...configuration,
      rules: configuration.rules.map((rule) => ({
        ...rule,
        targetGroupId: configuration.fallbackGroupId
      }))
    };
    await controller.replaceConfiguration(edited);
    expect(fake.calls).toEqual([]);
  });

  it("leaves a tab in an unmanaged native group until restart", async () => {
    const configuration = docsConfiguration();
    const current = tab({ chromeGroupId: 99 });
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [current],
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
      session: createMemorySessionRepository()
    });

    await controller.handleChromeEvent({
      kind: "tabMoved",
      tabId: current.id,
      windowId: 1,
      fromIndex: 0,
      toIndex: 1
    });

    fake.calls.length = 0;
    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: current.id,
      urlChanged: true,
      groupChanged: false,
      pinnedChanged: false
    });
    await controller.replaceConfiguration({
      ...configuration,
      rules: []
    });

    expect(fake.calls.filter((call) => call !== "update-group")).toEqual([]);
  });

  it("does not mutate shared-group members", async () => {
    const configuration = docsConfiguration();
    const current = tab({ chromeGroupId: 88 });
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [current],
      groups: [
        {
          id: 88,
          windowId: 1,
          title: "Shared",
          color: "grey",
          collapsed: false,
          shared: true
        }
      ],
      capturedAt: 1
    });
    const controller = createTabRouteController({
      configuration,
      chrome: fake.port,
      session: createMemorySessionRepository()
    });

    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: current.id,
      urlChanged: true,
      groupChanged: false,
      pinnedChanged: false
    });

    expect(fake.calls).toEqual([]);
  });

  it("does not clear override on tabActivated after manual move", async () => {
    const configuration = docsConfiguration();
    const current = tab();
    const session = createMemorySessionRepository();
    const fake = fakePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [current],
      groups: [],
      capturedAt: 1
    });
    const controller = createTabRouteController({
      configuration,
      chrome: fake.port,
      session
    });

    await controller.handleChromeEvent({
      kind: "tabAttached",
      tabId: current.id,
      newWindowId: 1,
      newPosition: 2
    });
    await controller.handleChromeEvent({
      kind: "tabActivated",
      tabId: current.id,
      windowId: 1
    });

    expect((await session.loadSession()).manualOverrides[String(current.id)]).toBeDefined();
    fake.calls.length = 0;
    await controller.replaceConfiguration(configuration);
    expect(fake.calls).toEqual([]);
  });
});
