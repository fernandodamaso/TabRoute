import { describe, expect, it } from "vitest";
import {
  evaluateRule,
  selectRule,
  validateRuleActions
} from "../../src/rules/ruleEngine";
import type {
  ChromeInventory,
  ChromeTabSnapshot,
  Configuration,
  ConditionNode,
  Rule,
  UUID
} from "../../src/domain/types";
import { createDefaultConfiguration } from "../../src/domain/defaults";

const groupId = "00000000-0000-4000-8000-000000000002" as UUID;

function tab(overrides: Partial<ChromeTabSnapshot> = {}): ChromeTabSnapshot {
  return {
    id: 7,
    windowId: 1,
    index: 0,
    chromeGroupId: -1,
    url: "https://docs.example.com/guide/intro?utm_source=test#part",
    status: "complete",
    title: "Guide",
    pinned: false,
    active: true,
    incognito: false,
    lastAccessed: 1,
    ...overrides
  };
}

function inventory(current: ChromeTabSnapshot = tab()): ChromeInventory {
  return {
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [current],
    groups: [],
    capturedAt: 1
  };
}

function rule(
  id: string,
  positive: ConditionNode,
  priority: number,
  actions: Rule["actions"] = [{ kind: "group" }]
): Rule {
  return {
    schemaVersion: 1,
    id: id as UUID,
    targetGroupId: groupId,
    priority,
    positive,
    negative: [],
    actions,
    enabled: true,
    createdAt: 1,
    updatedAt: 1
  };
}

function configuration(rules: Rule[]): Configuration {
  const base = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  return {
    ...base,
    groups: [
      ...base.groups,
      {
        schemaVersion: 1,
        id: groupId,
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
    rules
  };
}

describe("nested rule public behavior", () => {
  it("matches nested AND/OR expressions and rejects a matching negative expression", () => {
    const positive: ConditionNode = {
      kind: "all",
      children: [
        {
          kind: "any",
          children: [
            { kind: "host", operator: "suffix", value: "example.com" },
            { kind: "title", operator: "exact", value: "Nope" }
          ]
        },
        { kind: "path", operator: "prefix", value: "/guide" }
      ]
    };
    const accepted = rule("00000000-0000-4000-8000-000000000010", positive, 10);
    const rejected = {
      ...accepted,
      id: "00000000-0000-4000-8000-000000000011" as UUID,
      negative: [
        {
          kind: "title",
          operator: "contains",
          value: "Guide"
        } satisfies ConditionNode
      ]
    };

    expect(evaluateRule(accepted, tab(), inventory(), [])).toMatchObject({
      matches: true,
      matchingLeafCount: 2
    });
    expect(evaluateRule(rejected, tab(), inventory(), [])).toMatchObject({
      matches: false
    });
  });

  it("selects by priority, specificity, matching leaves, literal length, and UUID", () => {
    const low = rule(
      "00000000-0000-4000-8000-000000000020",
      { kind: "url", operator: "regex", value: "docs" },
      1
    );
    const exactShort = rule(
      "00000000-0000-4000-8000-000000000022",
      { kind: "host", operator: "exact", value: "docs.example.com" },
      2
    );
    const exactLong = rule(
      "00000000-0000-4000-8000-000000000021",
      {
        kind: "all",
        children: [
          { kind: "host", operator: "exact", value: "docs.example.com" },
          { kind: "path", operator: "prefix", value: "/guide" }
        ]
      },
      2
    );
    const selected = selectRule({
      configuration: configuration([low, exactShort, exactLong]),
      tab: tab(),
      inventory: inventory(),
      associations: []
    });

    expect(selected?.rule.id).toBe(exactLong.id);
  });

  it("does not let unmanaged native groups satisfy an ungrouped condition", () => {
    const unmanagedTab = tab({ chromeGroupId: 42 });
    const currentPlacement: ConditionNode = {
      kind: "currentGroup",
      placement: { kind: "ungrouped" }
    };
    const candidate = rule(
      "00000000-0000-4000-8000-000000000030",
      currentPlacement,
      1
    );

    expect(
      evaluateRule(candidate, unmanagedTab, inventory(unmanagedTab), [])
    ).toMatchObject({ matches: false });
  });

  it("validates bounded action combinations before configuration replaces a valid rule", () => {
    expect(() =>
      validateRuleActions([{ kind: "ungroup" }, { kind: "makePersistent" }])
    ).toThrow(/makePersistent/);
    expect(() =>
      validateRuleActions([
        { kind: "group" },
        { kind: "setCollapsed", collapsed: true },
        { kind: "setCollapsed", collapsed: false }
      ])
    ).toThrow(/collapse/i);
    expect(
      validateRuleActions([
        { kind: "group" },
        { kind: "makePersistent" },
        { kind: "setCollapsed", collapsed: true }
      ])
    ).toEqual({ placement: "group" });
  });
});

it("skips a matching rule whose managed target is disabled", () => {
  const base = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const disabledId = "00000000-0000-4000-8000-000000000002" as UUID;
  const enabledId = "00000000-0000-4000-8000-000000000003" as UUID;
  const targetRule = (
    id: string,
    targetGroupId: UUID,
    priority: number
  ): Rule => ({
    schemaVersion: 1,
    id: id as UUID,
    targetGroupId,
    priority,
    positive: { kind: "host", operator: "exact", value: "docs.example.com" },
    negative: [],
    actions: [{ kind: "group" }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1
  });
  const configuration: Configuration = {
    ...base,
    groups: [
      ...base.groups,
      {
        schemaVersion: 1,
        id: disabledId,
        name: "Disabled",
        color: "blue",
        isFallback: false,
        isPersistent: false,
        enabled: false,
        defaultOrder: 1,
        defaultCollapsed: false,
        createdAt: 1,
        updatedAt: 1
      },
      {
        schemaVersion: 1,
        id: enabledId,
        name: "Enabled",
        color: "green",
        isFallback: false,
        isPersistent: false,
        enabled: true,
        defaultOrder: 2,
        defaultCollapsed: false,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    rules: [
      targetRule("00000000-0000-4000-8000-000000000010", disabledId, 20),
      targetRule("00000000-0000-4000-8000-000000000011", enabledId, 10)
    ]
  };
  expect(
    selectRule({
      configuration,
      tab: tab(),
      inventory: inventory(),
      associations: []
    })?.rule.targetGroupId
  ).toBe(enabledId);
  expect(
    selectRule({
      configuration: {
        ...configuration,
        groups: configuration.groups.map((group) =>
          group.id === enabledId ? { ...group, enabled: false } : group
        )
      },
      tab: tab(),
      inventory: inventory(),
      associations: []
    })
  ).toBeUndefined();
});
