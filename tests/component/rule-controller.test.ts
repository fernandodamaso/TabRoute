import { expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createTabRouteController } from "../../src/controller/controller";
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
  const fake = createFakeChromePort({
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [current],
    groups: [],
    capturedAt: 1
  });
  const controller = createTabRouteController({
    configuration,
    chrome: fake,
    session: createMemorySessionRepository()
  });

  await controller.handleTabUpdated(current);
  expect(fake.getInventory().groups[0]?.title).toBe("Docs");

  const blocked = tab({ title: "blocked guide", chromeGroupId: -1 });
  fake.getStorage().inventory.tabs = [blocked];
  fake.getStorage().inventory.groups = [];
  await controller.handleTabUpdated(blocked);
  expect(fake.getInventory().groups[0]?.title).toBe("Other");
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
  const fake = createFakeChromePort({
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
    chrome: fake,
    session: createMemorySessionRepository()
  });

  await controller.handleTabUpdated(current);
  expect(fake.callsFor("ungroupTabs").length).toBeGreaterThan(0);
  expect(fake.getInventory().tabs[0]?.chromeGroupId).toBe(-1);
});
