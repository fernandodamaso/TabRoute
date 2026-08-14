import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createTestController } from "../helpers/controllerPersistence";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import type { ChromeTabSnapshot } from "../../src/chrome/types";
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

function hasRoutingMutations(fake: ReturnType<typeof createFakeChromePort>) {
  return (
    fake.callsFor("groupTabs").length > 0 ||
    fake.callsFor("ungroupTabs").length > 0 ||
    fake.callsFor("moveTabs").length > 0
  );
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
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [current],
      groups: [],
      capturedAt: 1
    });
    const controller = createTestController({
      configuration,
      chrome: fake,
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
    expect(hasRoutingMutations(fake)).toBe(false);
  });

  it("leaves a tab in an unmanaged native group until restart", async () => {
    const configuration = docsConfiguration();
    const current = tab({ chromeGroupId: 99 });
    const fake = createFakeChromePort({
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
    const controller = createTestController({
      configuration,
      chrome: fake,
      session: createMemorySessionRepository()
    });

    await controller.handleChromeEvent({
      kind: "tabMoved",
      tabId: current.id,
      windowId: 1,
      fromIndex: 0,
      toIndex: 1
    });

    const hadRoutingBefore = hasRoutingMutations(fake);
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

    expect(hasRoutingMutations(fake)).toBe(hadRoutingBefore);
  });

  it("does not mutate shared-group members", async () => {
    const configuration = docsConfiguration();
    const current = tab({ chromeGroupId: 88 });
    const fake = createFakeChromePort({
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
    const controller = createTestController({
      configuration,
      chrome: fake,
      session: createMemorySessionRepository()
    });

    await controller.handleChromeEvent({
      kind: "tabUpdated",
      tabId: current.id,
      urlChanged: true,
      groupChanged: false,
      pinnedChanged: false
    });

    expect(hasRoutingMutations(fake)).toBe(false);
  });

  it("does not clear override on tabActivated after manual move", async () => {
    const configuration = docsConfiguration();
    const current = tab();
    const session = createMemorySessionRepository();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [current],
      groups: [],
      capturedAt: 1
    });
    const controller = createTestController({
      configuration,
      chrome: fake,
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

    expect(
      (await session.loadSession()).manualOverrides[String(current.id)]
    ).toBeDefined();
    const hadRoutingBefore = hasRoutingMutations(fake);
    await controller.replaceConfiguration(configuration);
    expect(hasRoutingMutations(fake)).toBe(hadRoutingBefore);
  });
});
