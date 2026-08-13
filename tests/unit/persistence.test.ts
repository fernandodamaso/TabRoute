import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { validateConfiguration } from "../../src/domain/schemas";
import type { Configuration, PersistentTab, UUID } from "../../src/domain/types";
import { deriveCanonicalUrl, isValidCanonicalUrl, matchesAcceptedUrl } from "../../src/persistence/acceptedUrl";
import {
  isGroupEligibleForRepair,
  matchesPersistentDefinition,
  persistentTabsForGroup
} from "../../src/persistence/requirements";
import {
  calculatePersistentRepairs,
  planPersistentRestore,
  type RestoreContext
} from "../../src/persistence/startupRestore";
import {
  advanceStartupSettlement,
  beginStartupRestore,
  recordWindowClosure,
  settlePendingWindowClosures,
  STARTUP_RECOVERY_ALARM
} from "../../src/persistence/startupCoordinator";
import { resolveHomeWindow } from "../../src/persistence/windowOwnership";
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
      deriveCanonicalUrl("https://docs.example.com/?utm_source=x#frag", config.duplicateSettings)
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
        { url: "https://docs.example.com/guide", routing: { kind: "routable", url: "https://docs.example.com/guide" } },
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
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" as const }],
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
    expect(repairs.flatMap((repair) => repair.actions).map((action) => action.kind)).toEqual([
      "createTab",
      "assignTabsToManagedGroup"
    ]);
  });

  it("returns a dragged-out survivor before pause would hold routing", () => {
    const config = configuration({
      globalPausedUntil: Date.now() + 60_000
    });
    const context = restoreContext(config);
    const inventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" as const }],
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
});

describe("window ownership", () => {
  it("never chooses WINDOW_ID_NONE and ignores poisoned ownership windowId fields", () => {
    const inventory = {
      windows: [{ id: 2, focused: true, incognito: false, type: "normal" as const }],
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
});

describe("startup coordinator", () => {
  it("resumes interrupted startup settlement from session timestamps", async () => {
    const session = {
      ...createEmptyRuntimeSession({ browserSessionId: "session" as never }),
      startupRestore: beginStartupRestore(1000)
    };
    const alarms: { calls: Array<{ name: string; when: number }> } = { calls: [] };
    const inventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" as const }],
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
      clock: { now: () => 1000, waitInWorker: async () => undefined },
      chromeEvent: { kind: "startup" },
      timing: { quietMs: 10, maxMs: 100, recoveryAlarmMs: 200 }
    });
    expect(waiting.kind).toBe("waiting");
    const settled = await advanceStartupSettlement({
      session: waiting.session,
      inventory,
      alarms: {
        scheduleOneShot: async () => undefined
      },
      clock: { now: () => 5000, waitInWorker: async () => undefined },
      chromeEvent: { kind: "alarm", name: STARTUP_RECOVERY_ALARM },
      timing: { quietMs: 10, maxMs: 100, recoveryAlarmMs: 200 }
    });
    expect(settled.kind).toBe("settled");
    expect(alarms.calls.some((call) => call.name === STARTUP_RECOVERY_ALARM)).toBe(true);
  });

  it("marks persistent groups intentionally closed when a normal window remains", () => {
    const session = recordWindowClosure({
      session: createEmptyRuntimeSession({ browserSessionId: "session" as never }),
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
      session: createEmptyRuntimeSession({ browserSessionId: "session" as never }),
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
    expect(validateConfiguration({ ...config, restorePersistentGroups: undefined }).restorePersistentGroups).toBe(true);
  });
});

describe("architecture", () => {
  it("keeps chrome.tabs.create out of persistence modules", () => {
    const root = join(process.cwd(), "src", "persistence");
    const files = ["acceptedUrl.ts", "requirements.ts", "windowOwnership.ts", "startupRestore.ts", "startupCoordinator.ts", "persistentCommands.ts"];
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/chrome\.tabs\.create/);
    }
  });
});
