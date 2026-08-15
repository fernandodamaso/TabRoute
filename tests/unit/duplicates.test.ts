import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { resolveDuplicatePolicy } from "../../src/duplicates/policy";
import { buildDuplicateKey } from "../../src/duplicates/normalizeUrl";
import { observeInventory } from "../../src/duplicates/observations";
import { planDuplicateClose } from "../../src/duplicates/planDuplicateClose";
import {
  resolveDuplicate,
  selectDuplicateSurvivor
} from "../../src/duplicates/resolveDuplicate";
import type {
  ChromeInventory,
  ManagedGroup,
  Rule,
  TabSnapshot,
  UUID
} from "../../src/domain/types";

const groupId = "00000000-0000-4000-8000-000000000002" as UUID;

function tab(id: number, overrides: Partial<TabSnapshot> = {}): TabSnapshot {
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

describe("duplicates", () => {
  it("uses exclusion, then rule, group, and global precedence", () => {
    const global = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    ).duplicateSettings;
    const group: ManagedGroup = {
      schemaVersion: 1,
      id: groupId,
      name: "Work",
      color: "blue",
      isFallback: false,
      enabled: true,
      isPersistent: false,
      defaultOrder: 1,
      defaultCollapsed: false,
      duplicatePolicy: { kind: "urlAndTitle" },
      createdAt: 1,
      updatedAt: 1
    };
    const rule: Rule = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000010" as UUID,
      targetGroupId: groupId,
      priority: 1,
      positive: { kind: "host", operator: "suffix", value: "example.com" },
      negative: [],
      actions: [{ kind: "setDuplicatePolicy", policy: { kind: "domain" } }],
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    };
    expect(
      resolveDuplicatePolicy(
        rule,
        group,
        { ...global, globalPolicy: { kind: "exactUrl" } },
        true
      ).kind
    ).toBe("domain");
    expect(
      resolveDuplicatePolicy(
        null,
        group,
        { ...global, globalPolicy: { kind: "exactUrl" } },
        true
      ).kind
    ).toBe("urlAndTitle");
    expect(
      resolveDuplicatePolicy(
        null,
        group,
        { ...global, globalPolicy: { kind: "exactUrl" } },
        false
      ).kind
    ).toBe("exactUrl");
    expect(
      resolveDuplicatePolicy(
        null,
        group,
        {
          ...global,
          globalPolicy: { kind: "exactUrl" },
          globalExclusions: ["*excluded.test*"]
        },
        true,
        "https://excluded.test/a"
      ).kind
    ).toBe("allow");
  });

  it("returns null duplicate key for pending URLs", () => {
    const settings = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    ).duplicateSettings;
    expect(
      buildDuplicateKey(
        tab(1, { routing: { kind: "pending" }, url: undefined }),
        { kind: "exactUrl" },
        settings
      )
    ).toBeNull();
  });

  it("strips tracking params and drops hash for fragmentlessUrl", () => {
    const settings = {
      ...createDefaultConfiguration(
        () => "00000000-0000-4000-8000-000000000001"
      ).duplicateSettings,
      trackingParameters: ["utm_source"]
    };
    expect(
      buildDuplicateKey(
        tab(1, {
          routing: { kind: "routable", url: "https://x.test/a?utm_source=y#z" }
        }),
        { kind: "fragmentlessUrl" },
        settings
      )
    ).toBe("https://x.test/a");
  });
  it("scopes pattern keys to matching normalized URLs", () => {
    const settings = {
      ...createDefaultConfiguration(
        () => "00000000-0000-4000-8000-000000000001"
      ).duplicateSettings,
      trackingParameters: ["utm_source"]
    };
    const policy = {
      kind: "pattern" as const,
      pattern: "https://docs.example/guide*"
    };
    expect(
      buildDuplicateKey(
        tab(1, {
          routing: {
            kind: "routable",
            url: "https://docs.example/guide?utm_source=x"
          }
        }),
        policy,
        settings
      )
    ).toBe(policy.pattern);
    expect(
      buildDuplicateKey(
        tab(2, {
          routing: { kind: "routable", url: "https://other.example/guide" }
        }),
        policy,
        settings
      )
    ).toBeNull();
  });

  it("ungroup skips group override", () => {
    const global = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    ).duplicateSettings;
    const group: ManagedGroup = {
      schemaVersion: 1,
      id: groupId,
      name: "Work",
      color: "blue",
      isFallback: false,
      enabled: true,
      isPersistent: false,
      defaultOrder: 1,
      defaultCollapsed: false,
      duplicatePolicy: { kind: "domain" },
      createdAt: 1,
      updatedAt: 1
    };
    expect(resolveDuplicatePolicy(null, group, global, false).kind).toBe(
      "allow"
    );
  });

  it("prefers correct placement, then lastAccessed, then oldest ordinal, then tabId", async () => {
    const sessionRepo = createMemorySessionRepository();
    const session = {
      ...(await sessionRepo.loadSession()),
      tabObservations: [
        {
          tabId: 1,
          firstObservedAt: 1,
          firstObservedOrdinal: 2,
          lastObservedUrl: ""
        },
        {
          tabId: 2,
          firstObservedAt: 1,
          firstObservedOrdinal: 1,
          lastObservedUrl: ""
        }
      ]
    };
    const survivor = selectDuplicateSurvivor(
      [
        tab(1, { lastAccessed: 1, chromeGroupId: 11 }),
        tab(2, { lastAccessed: 2, chromeGroupId: -1 })
      ],
      "ungrouped",
      [],
      session
    );
    expect(survivor.id).toBe(2);
  });

  it("keeps ordinals across worker recreation and reseeds after browser restart", async () => {
    const inventory: ChromeInventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 2,
          windowId: 1,
          index: 1,
          chromeGroupId: -1,
          url: "https://a.test/",
          title: "A",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        },
        {
          id: 1,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://b.test/",
          title: "B",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 2
        }
      ],
      groups: [],
      capturedAt: 1
    };
    const sessionRepo = createMemorySessionRepository();
    const first = observeInventory(inventory, await sessionRepo.loadSession());
    expect(first.session.tabObservations.map((o) => o.tabId)).toEqual([1, 2]);
    const second = observeInventory(inventory, first.session);
    expect(
      second.session.tabObservations.map((o) => o.firstObservedOrdinal)
    ).toEqual(first.session.tabObservations.map((o) => o.firstObservedOrdinal));
    const restarted = observeInventory(inventory, {
      ...first.session,
      tabObservations: [],
      nextObservationOrdinal: 0
    });
    expect(restarted.session.tabObservations.map((o) => o.tabId)).toEqual([
      1, 2
    ]);
  });

  it("resolves duplicates from the triggering tab key, not the first eligible tab", async () => {
    const configuration = {
      ...createDefaultConfiguration(
        () => "00000000-0000-4000-8000-000000000001"
      ),
      duplicateSettings: {
        ...createDefaultConfiguration(
          () => "00000000-0000-4000-8000-000000000001"
        ).duplicateSettings,
        globalPolicy: { kind: "exactUrl" as const }
      }
    };
    const sessionRepo = createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    const tabs = [
      tab(1, {
        routing: { kind: "routable", url: "https://unique.test/only" }
      }),
      tab(2, {
        lastAccessed: 1,
        routing: { kind: "routable", url: "https://pair.test/shared" }
      }),
      tab(3, {
        lastAccessed: 3,
        routing: { kind: "routable", url: "https://pair.test/shared" }
      })
    ];
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs,
      groups: [],
      capturedAt: 1
    };
    const decision = resolveDuplicate({
      inventory,
      tabs,
      triggeringTab: tabs[2]!,
      configuration,
      associations: [],
      session,
      rule: null,
      destination: "ungrouped",
      destinationManaged: false,
      destinationGroup: null
    });
    expect(decision?.survivor.id).toBe(3);
    expect(
      decision?.duplicatesToClose.map((candidate) => candidate.id)
    ).toEqual([2]);
  });

  it("moves a survivor that is in the wrong group before close", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const workId = configuration.groups[0]!.id;
    const decision = {
      survivor: tab(1, { chromeGroupId: 10, lastAccessed: 3 }),
      duplicatesToClose: [tab(2, { lastAccessed: 1 })],
      destination: workId,
      moveSurvivor: true,
      focusSurvivor: true
    };
    const plan = planDuplicateClose(decision, configuration, []);
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "assignTabsToManagedGroup",
      "focusTab",
      "closeDuplicate"
    ]);
  });
});
