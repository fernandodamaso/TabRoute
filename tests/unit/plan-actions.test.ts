import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { planRuleRoute } from "../../src/actions/planActions";
import type { ChromeInventory, UUID } from "../../src/domain/types";

const docsId = "00000000-0000-4000-8000-000000000002" as UUID;

function inventory(): ChromeInventory {
  return {
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [
      {
        id: 7,
        windowId: 1,
        index: 0,
        chromeGroupId: -1,
        url: "https://docs.example.com/guide",
        title: "Guide",
        pinned: false,
        active: true,
        incognito: false,
        lastAccessed: 1
      }
    ],
    groups: [],
    capturedAt: 1
  };
}

describe("planRuleRoute", () => {
  it("routes to fallback when the target group was intentionally closed", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const withDocs = {
      ...configuration,
      groups: [
        ...configuration.groups,
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
            kind: "host" as const,
            operator: "exact" as const,
            value: "docs.example.com"
          },
          negative: [],
          actions: [{ kind: "group" as const }],
          enabled: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    };
    const planned = planRuleRoute({
      inventory: inventory(),
      tab: inventory().tabs[0]!,
      configuration: withDocs,
      associations: [],
      intentionallyClosedGroupIds: [docsId]
    });
    expect(planned.kind).toBe("routeToFallback");
  });
  it("keeps an ungroup rule selectable when its configured group is disabled, paused, or absent", () => {
    const base = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const targetRule = {
      schemaVersion: 1 as const,
      id: "00000000-0000-4000-8000-000000000011" as UUID,
      targetGroupId: docsId,
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
    };
    for (const groups of [
      [{ ...base.groups[0]!, id: docsId, enabled: false }],
      [
        {
          ...base.groups[0]!,
          id: docsId,
          enabled: true,
          pausedUntil: Date.now() + 60_000
        }
      ],
      base.groups
    ]) {
      const configuration = {
        ...base,
        groups,
        rules: [targetRule]
      };
      const tab = { ...inventory().tabs[0]!, chromeGroupId: 42 };
      const planned = planRuleRoute({
        inventory: { ...inventory(), tabs: [tab] },
        tab,
        configuration,
        associations: []
      });
      expect(planned.kind).toBe("ungroup");
    }
  });
});
