import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createTabRouteController } from "../../src/controller/controller";
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
      inventory.groups = [
        ...inventory.groups,
        {
          id,
          windowId: input.windowId,
          title: "",
          color: "grey" as const,
          collapsed: false,
          shared: false
        }
      ].filter(
        (group, index, groups) =>
          groups.findIndex((candidate) => candidate.id === group.id) === index
      );
      inventory.tabs = inventory.tabs.map((candidate) =>
        input.tabIds.includes(candidate.id)
          ? { ...candidate, chromeGroupId: id }
          : candidate
      );
      return id;
    },
    async ungroupTabs() {
      calls.push("ungroup-tabs");
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
  return { port, calls, getInventory: () => inventory };
}

it("holds a newly created tab until it has a committed supported URL", async () => {
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
    session: createMemorySessionRepository()
  });

  await controller.handleTabUpdated(tab({ url: undefined, status: "loading" }));

  expect(fake.calls).toEqual([]);
});

it("routes an unmatched routable tab through the Action Engine into lazy Other", async () => {
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
    session: createMemorySessionRepository()
  });

  await controller.handleTabUpdated(tab());

  expect(fake.calls).toEqual(["create-group", "update-group"]);
  expect(fake.getInventory().tabs[0]?.chromeGroupId).toBe(11);
  expect(fake.getInventory().groups[0]?.title).toBe("Other");
});

it("reuses each normal window's fallback group after fresh association reconstruction", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const first = tab({ id: 7, windowId: 1 });
  const second = tab({ id: 8, windowId: 2 });
  const fake = fakePort({
    windows: [
      { id: 1, focused: true, incognito: false, type: "normal" },
      { id: 2, focused: false, incognito: false, type: "normal" }
    ],
    tabs: [first, second],
    groups: [
      {
        id: 13,
        windowId: 1,
        title: "Other",
        color: "grey",
        collapsed: false,
        shared: false
      },
      {
        id: 14,
        windowId: 2,
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
    session: createMemorySessionRepository()
  });

  await controller.handleTabUpdated(first);
  await controller.handleTabUpdated(second);

  expect(fake.calls).toEqual([
    "reuse-group",
    "update-group",
    "reuse-group",
    "update-group"
  ]);
  expect(
    fake.getInventory().tabs.find((candidate) => candidate.id === first.id)
      ?.chromeGroupId
  ).toBe(13);
  expect(
    fake.getInventory().tabs.find((candidate) => candidate.id === second.id)
      ?.chromeGroupId
  ).toBe(14);
});
