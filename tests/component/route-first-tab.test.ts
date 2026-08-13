import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createTabRouteController } from "../../src/controller/controller";
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

it("holds a newly created tab until it has a committed supported URL", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const fake = createFakeChromePort({
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [tab({ url: undefined, status: "loading" })],
    groups: [],
    capturedAt: 1
  });
  const controller = createTabRouteController({
    configuration,
    chrome: fake,
    session: createMemorySessionRepository()
  });

  await controller.handleTabUpdated(tab({ url: undefined, status: "loading" }));

  expect(fake.callsFor("groupTabs")).toEqual([]);
});

it("routes an unmatched routable tab through the Action Engine into lazy Other", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const fake = createFakeChromePort({
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [tab()],
    groups: [],
    capturedAt: 1
  });
  const controller = createTabRouteController({
    configuration,
    chrome: fake,
    session: createMemorySessionRepository()
  });

  await controller.handleTabUpdated(tab());

  expect(fake.callsFor("groupTabs").length).toBe(1);
  expect(fake.callsFor("updateGroup").length).toBe(1);
  expect(fake.getInventory().tabs[0]?.chromeGroupId).toBeGreaterThan(0);
  expect(fake.getInventory().groups[0]?.title).toBe("Other");
});

it("reuses each normal window's fallback group after fresh association reconstruction", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const first = tab({ id: 7, windowId: 1 });
  const second = tab({ id: 8, windowId: 2 });
  const fake = createFakeChromePort({
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
    chrome: fake,
    session: createMemorySessionRepository()
  });

  await controller.handleTabUpdated(first);
  await controller.handleTabUpdated(second);

  expect(fake.callsFor("groupTabs")).toHaveLength(2);
  expect(fake.callsFor("updateGroup")).toHaveLength(2);
  expect(
    fake.getInventory().tabs.find((candidate) => candidate.id === first.id)
      ?.chromeGroupId
  ).toBe(13);
  expect(
    fake.getInventory().tabs.find((candidate) => candidate.id === second.id)
      ?.chromeGroupId
  ).toBe(14);
});
