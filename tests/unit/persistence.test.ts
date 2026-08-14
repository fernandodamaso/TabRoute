import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { validateConfiguration } from "../../src/domain/schemas";
import type {
  Configuration,
  PersistentTab,
  UUID
} from "../../src/domain/types";
import {
  deriveCanonicalUrl,
  isValidCanonicalUrl,
  matchesAcceptedUrl
} from "../../src/persistence/acceptedUrl";
import {
  calculatePersistentRepairs,
  planPersistentRestore,
  planPersistentTabOrdering,
  planRepairForTab,
  type RestoreContext
} from "../../src/persistence/startupRestore";
import {
  collectLiveMemberUrls,
  isGroupEligibleForRepair,
  matchesPersistentDefinition,
  persistentTabsForGroup
} from "../../src/persistence/requirements";
import {
  makePersistentDefinition,
  pinGroupDefinitions
} from "../../src/persistence/persistentCommands";
import {
  advanceStartupSettlement,
  beginStartupRestore,
  recordWindowClosure,
  settlePendingWindowClosures,
  STARTUP_RECOVERY_ALARM,
  WINDOW_SETTLEMENT_ALARM
} from "../../src/persistence/startupCoordinator";
import {
  captureOwnershipDescriptor,
  resolveHomeWindow
} from "../../src/persistence/windowOwnership";
import { createEmptyRuntimeSession } from "../../src/state/runtimeSession";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const groupId = "00000000-0000-4000-8000-000000000002" as UUID;
const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
const persistentId = "00000000-0000-4000-8000-000000000010" as UUID;

function configuration(overrides: Partial<Configuration> = {}): Configuration {
  const base = createDefaultConfiguration(() => fallbackId);
  const group = {
    schemaVersion: 1 as const,
    id: groupId,
    name: "Docs",
    color: "blue" as const,
    isFallback: false,
    enabled: true,
    isPersistent: true,
    defaultOrder: 1,
    defaultCollapsed: false,
    createdAt: 1,
    updatedAt: 1
  };
  const definition: PersistentTab = {
    schemaVersion: 1,
    id: persistentId,
    managedGroupId: groupId,
    canonicalUrl: "https://docs.example.com/guide",
    acceptedPatterns: ["https://docs.example.com/guide"],
    order: 0,
    createdAt: 1,
    updatedAt: 1
  };
  return {
    ...base,
    groups: [...base.groups, group],
    persistentTabs: [definition],
    restorePersistentGroups: true,
    ...overrides
  };
}

function restoreContext(config: Configuration): RestoreContext {
  return {
    configuration: config,
    associations: [
      {
        managedGroupId: groupId,
        chromeGroupId: 11,
        chromeWindowId: 1,
        observedTitle: "Docs",
        observedMemberUrls: ["https://docs.example.com/guide"],
        observedAt: 1
      }
    ],
    ownership: {
      [groupId]: {
        memberUrls: ["https://docs.example.com/guide"],
        order: 1,
        collapsed: false
      }
    },
    lastFocusedWindowId: 1,
    intentionallyClosedGroupIds: []
  };
}

describe("persistence accepted URLs", () => {
  it("rejects invalid canonical URLs and accepts portable definitions", () => {
    expect(isValidCanonicalUrl("https://docs.example.com/")).toBe(true);
    expect(isValidCanonicalUrl("not-a-url")).toBe(false);
    const config = configuration({
      duplicateSettings: {
        ...configuration().duplicateSettings,
        trackingParameters: ["utm_source"]
      }
    });
    expect(
      deriveCanonicalUrl(
        "https://docs.example.com/?utm_source=x#frag",
        config.duplicateSettings
      )
    ).toBe("https://docs.example.com/");
    expect(
      matchesAcceptedUrl(
        "https://docs.example.com/guide",
        "https://docs.example.com/guide",
        ["https://docs.example.com/guide"]
      )
    ).toBe(true);
  });
});

describe("persistent requirements", () => {
  it("keeps disabled groups out of repair and fallback always enabled", () => {
    const config = configuration({
      groups: [
        ...configuration().groups.map((group) =>
          group.id === groupId ? { ...group, enabled: false } : group
        )
      ]
    });
    expect(isGroupEligibleForRepair(config, groupId, [])).toBe(false);
    expect(isGroupEligibleForRepair(config, fallbackId, [])).toBe(true);
  });

  it("matches definitions by canonical and accepted patterns", () => {
    const def = configuration().persistentTabs[0]!;
    expect(
      matchesPersistentDefinition(
        {
          url: "https://docs.example.com/guide",
          routing: { kind: "routable", url: "https://docs.example.com/guide" }
        },
        def
      )
    ).toBe(true);
    expect(persistentTabsForGroup(configuration(), groupId).length).toBe(1);
  });
});

describe("startup restore planning", () => {
  it("recreates a missing canonical tab with createTab then assign", () => {
    const config = configuration();
    const context = restoreContext(config);
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue" as const,
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const repairs = calculatePersistentRepairs(
      config.persistentTabs[0]!,
      inventory,
      context,
      1
    );
    expect(repairs[0]?.action).toBe("recreate");
    expect(
      repairs.flatMap((repair) => repair.actions).map((action) => action.kind)
    ).toEqual(["createTab", "assignTabsToManagedGroup"]);
  });

  it("returns a dragged-out survivor before pause would hold routing", () => {
    const config = configuration({
      globalPausedUntil: Date.now() + 60_000
    });
    const context = restoreContext(config);
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [
        {
          id: 5,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://docs.example.com/guide",
          title: "Guide",
          pinned: false,
          active: false,
          incognito: false as const,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    };
    const repairs = calculatePersistentRepairs(
      config.persistentTabs[0]!,
      inventory,
      context,
      1
    );
    expect(repairs[0]?.action).toBe("return");
  });

  it("skips startup restore when restorePersistentGroups is false", () => {
    const config = configuration({ restorePersistentGroups: false });
    const plan = planPersistentRestore(
      config,
      {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 1
      },
      restoreContext(config)
    );
    expect(plan).toBeNull();
  });

  it("routes matches to Other while a persistent group is intentionally closed", () => {
    const config = configuration();
    const context = {
      ...restoreContext(config),
      intentionallyClosedGroupIds: [groupId]
    };
    const repairs = calculatePersistentRepairs(
      config.persistentTabs[0]!,
      {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 1
      },
      context,
      1
    );
    expect(repairs).toEqual([]);
  });

  it("recreates a missing canonical tab when the group has no member tabs", () => {
    const config = configuration();
    const context = restoreContext(config);
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue" as const,
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const repairs = calculatePersistentRepairs(
      config.persistentTabs[0]!,
      inventory,
      context,
      1
    );
    expect(repairs[0]?.action).toBe("recreate");
  });

  it("reclassifies a navigated required tab and recreates the canonical URL in background", () => {
    const config = configuration();
    const context = restoreContext(config);
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [
        {
          id: 8,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://github.com/",
          title: "GitHub",
          pinned: false,
          active: true,
          incognito: false as const,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue" as const,
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const repairs = calculatePersistentRepairs(
      config.persistentTabs[0]!,
      inventory,
      context,
      1
    );
    expect(repairs[0]).toEqual(
      expect.objectContaining({
        action: "reclassifyAndRecreate",
        targetManagedGroupId: groupId
      })
    );
  });

  it("planRepairForTab reclassifies a navigated tab still in the managed group", () => {
    const config = configuration();
    const context = restoreContext(config);
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [
        {
          id: 8,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://github.com/",
          title: "GitHub",
          pinned: false,
          active: true,
          incognito: false as const,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue" as const,
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const repairs = planRepairForTab(inventory.tabs[0]!, inventory, context);
    expect(repairs[0]).toEqual(
      expect.objectContaining({
        action: "reclassifyAndRecreate",
        targetManagedGroupId: groupId
      })
    );
  });

  it("keeps a displaced persistent tab anchored to its associated group home", () => {
    const config = configuration();
    const context = restoreContext(config);
    const displaced = {
      id: 8,
      windowId: 2,
      index: 0,
      chromeGroupId: -1,
      url: "https://docs.example.com/guide",
      title: "Guide",
      pinned: false,
      active: true,
      incognito: false as const,
      lastAccessed: 1
    };
    const inventory = {
      windows: [
        { id: 1, focused: false, incognito: false, type: "normal" as const },
        { id: 2, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [
        displaced,
        {
          id: 9,
          windowId: 1,
          index: 3,
          chromeGroupId: 11,
          url: "https://docs.example.com/other",
          title: "Other",
          pinned: false,
          active: false,
          incognito: false as const,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue" as const,
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };

    const repairs = planRepairForTab(displaced, inventory, context);
    const assign = repairs[0]?.actions.find(
      (action) => action.kind === "assignTabsToManagedGroup"
    );
    expect(assign?.kind).toBe("assignTabsToManagedGroup");
    if (assign?.kind === "assignTabsToManagedGroup")
      expect(assign.windowId).toBe(1);
  });

  it("planRepairForTab still repairs when restorePersistentGroups is false", () => {
    const config = configuration({ restorePersistentGroups: false });
    const context = restoreContext(config);
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [
        {
          id: 8,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://github.com/",
          title: "GitHub",
          pinned: false,
          active: true,
          incognito: false as const,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue" as const,
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const repairs = planRepairForTab(inventory.tabs[0]!, inventory, context);
    expect(repairs[0]?.action).toBe("reclassifyAndRecreate");
  });

  it("creates a managed canonical copy when only a shared-group tab matches", () => {
    const config = configuration();
    const context = restoreContext(config);
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [
        {
          id: 9,
          windowId: 1,
          index: 0,
          chromeGroupId: 99,
          url: "https://docs.example.com/guide",
          title: "Shared copy",
          pinned: false,
          active: false,
          incognito: false as const,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue" as const,
          collapsed: false,
          shared: false
        },
        {
          id: 99,
          windowId: 1,
          title: "Shared",
          color: "grey" as const,
          collapsed: false,
          shared: true
        }
      ],
      capturedAt: 1
    };
    const repairs = calculatePersistentRepairs(
      config.persistentTabs[0]!,
      inventory,
      context,
      1
    );
    expect(repairs[0]?.action).toBe("recreate");
    expect(
      repairs
        .flatMap((repair) => repair.actions)
        .some((action) => action.kind === "createTab")
    ).toBe(true);
  });

  it("orders persistent tabs before temporary members in restore plans", () => {
    const config = configuration();
    const context = restoreContext(config);
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [
        {
          id: 10,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://temp.example.com/",
          title: "Temp",
          pinned: false,
          active: false,
          incognito: false as const,
          lastAccessed: 1
        },
        {
          id: 11,
          windowId: 1,
          index: 1,
          chromeGroupId: 11,
          url: "https://docs.example.com/guide",
          title: "Guide",
          pinned: false,
          active: false,
          incognito: false as const,
          lastAccessed: 2
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue" as const,
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const group = config.groups.find((candidate) => candidate.id === groupId)!;
    const ordering = planPersistentTabOrdering(
      group,
      config,
      inventory,
      context.associations,
      1
    );
    expect(ordering).toEqual([
      expect.objectContaining({
        kind: "reorderTabs",
        tabs: [{ kind: "live", tabId: 11 }],
        windowId: 1,
        index: 0
      })
    ]);
  });
});

describe("pin group commands", () => {
  it("collects live routable member URLs from the associated chrome group", () => {
    const config = configuration({
      duplicateSettings: {
        ...configuration().duplicateSettings,
        trackingParameters: ["utm_source"]
      }
    });
    const urls = collectLiveMemberUrls(
      groupId,
      config,
      {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 1,
            windowId: 1,
            index: 0,
            chromeGroupId: 11,
            url: "https://docs.example.com/guide?utm_source=x",
            title: "Guide",
            pinned: false,
            active: false,
            incognito: false,
            lastAccessed: 1
          },
          {
            id: 2,
            windowId: 1,
            index: 1,
            chromeGroupId: 11,
            url: "https://temp.example.com/",
            title: "Temp",
            pinned: false,
            active: false,
            incognito: false,
            lastAccessed: 2
          }
        ],
        groups: [
          {
            id: 11,
            windowId: 1,
            title: "Docs",
            color: "blue",
            collapsed: false,
            shared: false
          }
        ],
        capturedAt: 1
      },
      restoreContext(config).associations,
      1
    );
    expect(urls).toEqual({
      kind: "available",
      urls: ["https://docs.example.com/guide", "https://temp.example.com/"]
    });
  });

  it("pins only current members and drops stale persistent definitions", () => {
    const config = configuration({
      persistentTabs: [
        ...configuration().persistentTabs,
        {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000020" as UUID,
          managedGroupId: groupId,
          canonicalUrl: "https://stale.example.com/",
          acceptedPatterns: ["https://stale.example.com/"],
          order: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    });
    const pinned = pinGroupDefinitions(
      config,
      groupId,
      ["https://docs.example.com/guide"],
      () => 2
    );
    expect(
      pinned.groups.find((group) => group.id === groupId)?.isPersistent
    ).toBe(true);
    expect(
      pinned.persistentTabs.filter((tab) => tab.managedGroupId === groupId)
    ).toHaveLength(1);
    expect(pinned.persistentTabs[0]?.canonicalUrl).toBe(
      "https://docs.example.com/guide"
    );
  });

  it("makePersistent is idempotent for the same canonical URL", () => {
    const config = configuration();
    const first = makePersistentDefinition(
      config,
      groupId,
      "https://docs.example.com/guide",
      () => 2
    );
    const second = makePersistentDefinition(
      first,
      groupId,
      "https://docs.example.com/guide",
      () => 3
    );
    expect(
      second.persistentTabs.filter((tab) => tab.managedGroupId === groupId)
    ).toHaveLength(1);
  });
  it("reuses a target definition accepted by an existing pattern", () => {
    const config = configuration({
      persistentTabs: [
        {
          ...configuration().persistentTabs[0]!,
          acceptedPatterns: ["https://docs.example.com/guide*"]
        }
      ],
      duplicateSettings: {
        ...configuration().duplicateSettings,
        trackingParameters: ["utm_source"]
      }
    });
    const next = makePersistentDefinition(
      config,
      groupId,
      "https://docs.example.com/guide?utm_source=x",
      () => 3,
      () => "00000000-0000-4000-8000-000000000099"
    );
    expect(next).toBe(config);
    expect(next.persistentTabs).toHaveLength(1);
    expect(next.persistentTabs[0]?.id).toBe(persistentId);
  });
});

describe("window ownership", () => {
  it("never chooses WINDOW_ID_NONE and ignores poisoned ownership windowId fields", () => {
    const inventory = {
      windows: [
        { id: 2, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [
        {
          id: 3,
          windowId: 2,
          index: 0,
          chromeGroupId: 11,
          url: "https://docs.example.com/guide",
          title: "Guide",
          pinned: false,
          active: false,
          incognito: false as const,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    };
    const home = resolveHomeWindow(
      {
        memberUrls: ["https://docs.example.com/guide"],
        order: 1,
        collapsed: false,
        windowId: 999
      } as never,
      inventory,
      [3],
      -1
    );
    expect(home).toBe(2);
  });
  it("captures live group presentation and member-index order", () => {
    const descriptor = captureOwnershipDescriptor(
      groupId,
      configuration().groups.find((group) => group.id === groupId)!,
      {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 2,
            windowId: 1,
            index: 4,
            chromeGroupId: 11,
            url: "https://second.example/",
            title: "Second",
            pinned: false,
            active: false,
            incognito: false,
            lastAccessed: 1
          },
          {
            id: 1,
            windowId: 1,
            index: 1,
            chromeGroupId: 11,
            url: "https://first.example/",
            title: "First",
            pinned: false,
            active: false,
            incognito: false,
            lastAccessed: 1
          }
        ],
        groups: [
          {
            id: 11,
            windowId: 1,
            title: "Docs",
            color: "blue",
            collapsed: true,
            shared: false
          }
        ],
        capturedAt: 1
      },
      [
        {
          managedGroupId: groupId,
          chromeGroupId: 11,
          chromeWindowId: 1,
          observedTitle: "Docs",
          observedMemberUrls: [],
          observedAt: 1
        }
      ]
    );
    expect(descriptor).toEqual({
      memberUrls: ["https://first.example/", "https://second.example/"],
      order: 1,
      collapsed: true
    });
  });
});

describe("startup coordinator", () => {
  it("resumes interrupted startup settlement from session timestamps", async () => {
    const session = {
      ...createEmptyRuntimeSession({ browserSessionId: "session" as never }),
      startupRestore: beginStartupRestore(1000)
    };
    const alarms: { calls: Array<{ name: string; when: number }> } = {
      calls: []
    };
    const inventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" as const }
      ],
      tabs: [],
      groups: [],
      capturedAt: 1
    };
    const waiting = await advanceStartupSettlement({
      session,
      inventory,
      alarms: {
        scheduleOneShot: async (name, when) => {
          alarms.calls.push({ name, when });
        }
      },
      clock: { now: () => 1000 },
      chromeEvent: { kind: "startup" },
      timing: { quietMs: 10, maxMs: 100, recoveryAlarmMs: 200 }
    });
    expect(waiting.kind).toBe("waiting");
    let currentNow = 1010;
    const firstScan = await advanceStartupSettlement({
      session: waiting.session,
      inventory,
      alarms: {
        scheduleOneShot: async (name, when) => {
          alarms.calls.push({ name, when });
        }
      },
      clock: { now: () => currentNow },
      chromeEvent: { kind: "alarm", name: STARTUP_RECOVERY_ALARM },
      timing: { quietMs: 10, maxMs: 100, recoveryAlarmMs: 200 }
    });
    expect(firstScan.kind).toBe("waiting");
    expect(firstScan.session.startupRestore?.consecutiveQuietScans).toBe(1);
    expect(alarms.calls[0]?.when).toBe(1010);
    expect(alarms.calls[1]?.when).toBe(1020);
    currentNow = 1020;
    const secondScan = await advanceStartupSettlement({
      session: firstScan.session,
      inventory,
      alarms: { scheduleOneShot: async () => undefined },
      clock: { now: () => currentNow },
      chromeEvent: { kind: "alarm", name: STARTUP_RECOVERY_ALARM },
      timing: { quietMs: 10, maxMs: 100, recoveryAlarmMs: 200 }
    });
    expect(secondScan.kind).toBe("settled");
  });
  it("settles at the fifteen-second deadline without a worker wait", async () => {
    const session = createEmptyRuntimeSession({
      browserSessionId: "session" as never
    });
    const calls: number[] = [];
    const inventory = { windows: [], tabs: [], groups: [], capturedAt: 1 };
    const started = await advanceStartupSettlement({
      session,
      inventory,
      alarms: {
        scheduleOneShot: async (_name, when) => {
          calls.push(when);
        }
      },
      clock: { now: () => 1000 },
      chromeEvent: { kind: "startup" }
    });
    expect(started.kind).toBe("waiting");
    expect(calls[0]).toBeLessThanOrEqual(16000);
    const settled = await advanceStartupSettlement({
      session: started.session,
      inventory,
      alarms: { scheduleOneShot: async () => undefined },
      clock: { now: () => 16000 },
      chromeEvent: { kind: "alarm", name: STARTUP_RECOVERY_ALARM }
    });
    expect(settled.kind).toBe("settled");
  });

  it("returns idle without startupRestore on ordinary tab events", async () => {
    const session = createEmptyRuntimeSession({
      browserSessionId: "session" as never
    });
    const inventory = {
      windows: [],
      tabs: [],
      groups: [],
      capturedAt: 1
    };
    const outcome = await advanceStartupSettlement({
      session,
      inventory,
      alarms: { scheduleOneShot: async () => undefined },
      clock: { now: () => 5000 },
      chromeEvent: { kind: "tabCreated", tabId: 1 },
      timing: { quietMs: 10, maxMs: 100, recoveryAlarmMs: 200 }
    });
    expect(outcome.kind).toBe("idle");
  });

  it("does not reset startup quiet scans on window-settlement alarms", async () => {
    const session = {
      ...createEmptyRuntimeSession({ browserSessionId: "session" as never }),
      startupRestore: {
        startedAt: 1000,
        deadlineAt: 10000,
        lastRelevantEventAt: 1000,
        consecutiveQuietScans: 0 as const
      }
    };
    const inventory = {
      windows: [],
      tabs: [],
      groups: [],
      capturedAt: 1
    };
    const outcome = await advanceStartupSettlement({
      session,
      inventory,
      alarms: { scheduleOneShot: async () => undefined },
      clock: { now: () => 5000 },
      chromeEvent: { kind: "alarm", name: WINDOW_SETTLEMENT_ALARM },
      timing: { quietMs: 100, maxMs: 10000, recoveryAlarmMs: 200 }
    });
    expect(outcome.kind).toBe("waiting");
    expect(outcome.session.startupRestore?.lastRelevantEventAt).toBe(1000);
    expect(outcome.session.startupRestore?.consecutiveQuietScans).toBe(1);
  });

  it("merges repeated closure evidence for the same window", () => {
    const initial = createEmptyRuntimeSession({
      browserSessionId: "session" as never
    });
    const first = recordWindowClosure({
      session: initial,
      windowId: 9,
      managedGroupIds: [groupId],
      tabIds: [1],
      now: 1000
    });
    const second = recordWindowClosure({
      session: first,
      windowId: 9,
      managedGroupIds: [fallbackId],
      tabIds: [2],
      now: 1500
    });
    expect(second.pendingWindowClosures).toEqual([
      {
        windowId: 9,
        managedGroupIds: [groupId, fallbackId],
        tabIds: [1, 2],
        startedAt: 1500
      }
    ]);
  });
  it("marks persistent groups intentionally closed when a normal window remains", () => {
    const session = recordWindowClosure({
      session: createEmptyRuntimeSession({
        browserSessionId: "session" as never
      }),
      windowId: 9,
      managedGroupIds: [groupId],
      tabIds: [1],
      now: 1000
    });
    const settled = settlePendingWindowClosures({
      session,
      inventory: {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 1
      },
      now: 4000
    });
    expect(settled.intentionallyClosedGroupIds).toContain(groupId);
  });

  it("clears pending window closures on last-window shutdown without intentional markers", () => {
    const session = recordWindowClosure({
      session: createEmptyRuntimeSession({
        browserSessionId: "session" as never
      }),
      windowId: 9,
      managedGroupIds: [groupId],
      tabIds: [1],
      now: 1000
    });
    const settled = settlePendingWindowClosures({
      session,
      inventory: {
        windows: [],
        tabs: [],
        groups: [],
        capturedAt: 1
      },
      now: 4000
    });
    expect(settled.pendingWindowClosures).toEqual([]);
    expect(settled.intentionallyClosedGroupIds).toEqual([]);
  });
});

describe("configuration widening", () => {
  it("accepts persistent tabs without bumping schemaVersion", () => {
    const config = configuration();
    expect(validateConfiguration(config).schemaVersion).toBe(1);
    expect(validateConfiguration(config).persistentTabs.length).toBe(1);
    expect(
      validateConfiguration({ ...config, restorePersistentGroups: undefined })
        .restorePersistentGroups
    ).toBe(true);
  });
});

describe("architecture", () => {
  it("keeps chrome.tabs.create out of persistence modules", () => {
    const root = join(process.cwd(), "src", "persistence");
    const files = [
      "acceptedUrl.ts",
      "requirements.ts",
      "windowOwnership.ts",
      "startupRestore.ts",
      "startupCoordinator.ts",
      "persistentCommands.ts"
    ];
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/chrome\.tabs\.create/);
    }
  });
});
