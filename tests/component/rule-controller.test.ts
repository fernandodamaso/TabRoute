import { expect, it } from "vitest";
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
  const inventory = structuredClone(initial);
  const calls: string[] = [];
  const port: ChromeMutationPort = {
    async readInventory() {
      return inventory;
    },
    async groupTabs(input) {
      calls.push(input.kind === "create" ? "create-group" : "reuse-group");
      const id = input.kind === "create" ? 11 : input.chromeGroupId;
      if (!inventory.groups.some((group) => group.id === id))
        inventory.groups = [
          ...inventory.groups,
          {
            id,
            windowId: input.windowId,
            title: "",
            color: "grey",
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
    async ungroupTabs() {
      calls.push("ungroup-tabs");
      inventory.tabs = inventory.tabs.map((candidate) =>
        candidate.id === 7 ? { ...candidate, chromeGroupId: -1 } : candidate
      );
    },
    async moveTabs() {
      calls.push("move-tabs");
      inventory.tabs = inventory.tabs.map((candidate) =>
        candidate.id === 7 ? { ...candidate, chromeGroupId: -1 } : candidate
      );
    },
    async updateGroup(groupId, patch) {
      calls.push("update-group");
      inventory.groups = inventory.groups.map((group) =>
        group.id === groupId ? { ...group, ...patch } : group
      );
    }
  };
  return { port, calls, inventory };
}

it("routes nested positive matches to a managed group and negative matches to fallback", async () => {
  const base = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const configuration: Configuration = {
    ...base,
    groups: [
      ...base.groups,
      {
        schemaVersion: 1 as const,
        id: docsId,
        name: "Docs",
        color: "blue" as const,
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
        schemaVersion: 1 as const,
        id: "00000000-0000-4000-8000-000000000010" as UUID,
        targetGroupId: docsId,
        priority: 10,
        positive: {
          kind: "all" as const,
          children: [
            {
              kind: "host",
              operator: "exact" as const,
              value: "docs.example.com"
            },
            { kind: "path", operator: "prefix" as const, value: "/guide" }
          ]
        },
        negative: [
          { kind: "title", operator: "contains" as const, value: "blocked" }
        ],
        actions: [{ kind: "group" as const }],
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  };
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

  await controller.handleTabUpdated(current);
  expect(fake.inventory.groups[0]?.title).toBe("Docs");

  const blocked = tab({ title: "blocked guide", chromeGroupId: -1 });
  fake.inventory.tabs = [blocked];
  fake.inventory.groups = [];
  await controller.handleTabUpdated(blocked);
  expect(fake.inventory.groups[0]?.title).toBe("Other");
});

it("ungroups when the selected rule uses the ungroup placement action", async () => {
  const base = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const configuration: Configuration = {
    ...base,
    rules: [
      {
        schemaVersion: 1 as const,
        id: "00000000-0000-4000-8000-000000000010" as UUID,
        targetGroupId: base.fallbackGroupId,
        priority: 10,
        positive: {
          kind: "host" as const,
          operator: "exact" as const,
          value: "docs.example.com"
        },
        negative: [],
        actions: [{ kind: "ungroup" as const }],
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  };
  const current = tab({ chromeGroupId: 42 });
  const fake = fakePort({
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [current],
    groups: [
      {
        id: 42,
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

  await controller.handleTabUpdated(current);
  expect(fake.calls).toContain("ungroup-tabs");
  expect(fake.inventory.tabs[0]?.chromeGroupId).toBe(-1);
});
