import { describe, expect, it } from "vitest";
import { executeActionPlan } from "../../src/actions/executeActionPlan";
import { executeRoutePlan } from "../../src/actions/executeRoutePlan";
import type { RoutePlan } from "../../src/actions/types";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import { validateConfiguration } from "../../src/domain/schemas";
import type {
  ChromeInventory,
  Configuration,
  Snapshot,
  TabSnapshot,
  UUID
} from "../../src/domain/types";
import { observeInventory } from "../../src/duplicates/observations";
import { planDuplicateClose } from "../../src/duplicates/planDuplicateClose";
import {
  resolveDuplicate,
  selectDuplicateSurvivor
} from "../../src/duplicates/resolveDuplicate";
import {
  calculatePersistentRepairs,
  planPersistentRestore
} from "../../src/persistence/startupRestore";
import { evaluateCondition } from "../../src/rules/ruleEngine";
import { captureSnapshot } from "../../src/snapshots/captureSnapshot";
import {
  executePersistentRepairs,
  runPersistentRestore
} from "../../src/controller/persistentRepairRunner";
import {
  handleSnapshotAlarm,
  SNAPSHOT_ALARMS
} from "../../src/snapshots/snapshotScheduler";
import { restoreSnapshotFromRecord } from "../../src/snapshots/snapshotService";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import { createTestController } from "../helpers/controllerPersistence";
import {
  groupId,
  persistenceConfiguration
} from "../component/startup-restore.helpers";

const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
const workId = "00000000-0000-4000-8000-000000000002" as UUID;

function rawTab(
  id: number,
  overrides: Partial<ChromeInventory["tabs"][number]> = {}
): ChromeInventory["tabs"][number] {
  return {
    id,
    windowId: 1,
    index: id - 1,
    chromeGroupId: -1,
    url: "https://example.com/page",
    status: "complete",
    title: "Example",
    pinned: false,
    active: false,
    incognito: false,
    lastAccessed: id,
    ...overrides
  };
}

function inventory(
  tabs: ChromeInventory["tabs"],
  groups: ChromeInventory["groups"] = [],
  windows: ChromeInventory["windows"] = [
    { id: 1, focused: true, incognito: false, type: "normal" }
  ]
): ChromeInventory {
  return { windows, tabs, groups, capturedAt: 1 };
}

function actionDeps(
  configuration: Configuration,
  chrome: ReturnType<typeof createFakeChromePort>,
  local = createMemoryLocalRepository(),
  session = createMemorySessionRepository()
) {
  return {
    reads: chrome,
    mutations: chrome,
    checkpoints: { captureBefore: async () => undefined },
    local,
    session,
    configuration,
    now: () => 1_000,
    delay: async () => undefined
  };
}

function browserTab(input: {
  id: number;
  windowId: number;
  chromeGroupId: number;
  lastAccessed: number;
  url?: string;
}): TabSnapshot {
  const url = input.url ?? "https://example.com/page";
  return {
    ...rawTab(input.id, {
      windowId: input.windowId,
      chromeGroupId: input.chromeGroupId,
      lastAccessed: input.lastAccessed,
      url
    }),
    routing: { kind: "routable", url }
  };
}

function namedSnapshot(index: number): Snapshot {
  return {
    schemaVersion: 1,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID,
    name: `Named ${index}`,
    kind: "named",
    scope: { kind: "browser" },
    groups: [],
    createdAt: index,
    updatedAt: index
  };
}

describe("PR 10 remaining backend review regressions", () => {
  it("restores a group with individual persistent definitions even when whole-group persistence is off", () => {
    const base = persistenceConfiguration();
    const configuration: Configuration = {
      ...base,
      groups: base.groups.map((group) =>
        group.id === groupId ? { ...group, isPersistent: false } : group
      )
    };
    const raw = inventory([]);
    const plan = planPersistentRestore(configuration, raw, {
      configuration,
      associations: [],
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: []
    });

    expect(plan).not.toBeNull();
    expect(
      plan?.actions.some(
        (action) =>
          action.kind === "createTab" &&
          action.input.url === "https://docs.example.com/guide"
      )
    ).toBe(true);
  });

  it("recomputes persistent ordering after a missing tab is recreated", async () => {
    const configuration = persistenceConfiguration();
    const chrome = createFakeChromePort(
      inventory(
        [
          rawTab(1, {
            index: 0,
            chromeGroupId: 11,
            url: "https://temporary.example/"
          })
        ],
        [
          {
            id: 11,
            windowId: 1,
            title: "Docs",
            color: "blue",
            collapsed: false,
            shared: false
          }
        ]
      )
    );
    const associations = [
      {
        managedGroupId: groupId,
        chromeGroupId: 11,
        chromeWindowId: 1,
        observedTitle: "Docs",
        observedMemberUrls: ["https://temporary.example/"],
        observedAt: 1
      }
    ];
    const context = {
      configuration,
      associations,
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: []
    };
    const definition = configuration.persistentTabs[0]!;
    const repairs = calculatePersistentRepairs(
      definition,
      await chrome.readInventory(),
      context,
      1
    );

    const succeeded = await executePersistentRepairs({
      repairs,
      actionDeps: actionDeps(configuration, chrome),
      associations
    });

    expect(succeeded).toBe(true);
    expect(
      chrome.callsFor("moveTabs").some((call) => call[1] === 1 && call[2] === 0)
    ).toBe(true);
  });

  it("reports a failed startup restore so the coordinator can retry it", async () => {
    const configuration = persistenceConfiguration();
    const chrome = createFakeChromePort(inventory([]));
    chrome.setError("createTab", new Error("create failed"));
    const local = createMemoryLocalRepository();
    const sessionRepository = createMemorySessionRepository();
    const runtime = await sessionRepository.loadSession();

    const restored = await runPersistentRestore({
      configuration,
      chrome,
      session: runtime,
      local,
      associations: [],
      actionDeps: actionDeps(configuration, chrome, local, sessionRepository)
    });

    expect(restored).toBe(false);
  });

  it("does not install rule-created persistence in memory when durable persistence fails", async () => {
    const withGroup = createManagedGroup(
      createDefaultConfiguration(
        () => fallbackId,
        () => 1
      ),
      { name: "Work", color: "blue" },
      () => workId,
      () => 1
    );
    const configuration: Configuration = {
      ...withGroup,
      rules: [
        {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000010" as UUID,
          targetGroupId: workId,
          priority: 10,
          positive: { kind: "host", operator: "exact", value: "example.com" },
          negative: [],
          actions: [{ kind: "group" }, { kind: "makePersistent" }],
          enabled: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    };
    const tab = rawTab(7, { active: true });
    const chrome = createFakeChromePort(inventory([tab]));
    const controller = createTestController({
      configuration,
      chrome,
      persistConfiguration: async () => {
        throw new Error("sync failed");
      }
    });

    await expect(controller.handleTabUpdated(tab)).rejects.toThrow(
      "sync failed"
    );
    expect(controller.getConfiguration().persistentTabs).toHaveLength(0);
  });

  it("recognizes the correct managed-group instance in each Chrome window", async () => {
    const session = await createMemorySessionRepository().loadSession();
    const tabs = [
      browserTab({ id: 1, windowId: 1, chromeGroupId: 10, lastAccessed: 1 }),
      browserTab({ id: 2, windowId: 2, chromeGroupId: 20, lastAccessed: 5 })
    ];
    const survivor = selectDuplicateSurvivor(
      tabs,
      workId,
      [
        {
          managedGroupId: workId,
          chromeGroupId: 10,
          chromeWindowId: 1,
          observedTitle: "Work",
          observedMemberUrls: [],
          observedAt: 1
        },
        {
          managedGroupId: workId,
          chromeGroupId: 20,
          chromeWindowId: 2,
          observedTitle: "Work",
          observedMemberUrls: [],
          observedAt: 1
        }
      ],
      session
    );

    expect(survivor.id).toBe(2);
  });

  it("revalidates duplicate equivalence immediately before closing", async () => {
    const configuration: Configuration = {
      ...createDefaultConfiguration(
        () => fallbackId,
        () => 1
      ),
      duplicateSettings: {
        globalPolicy: { kind: "exactUrl" },
        globalExclusions: [],
        trackingParameters: []
      }
    };
    const chrome = createFakeChromePort(
      inventory([
        rawTab(1, { lastAccessed: 1 }),
        rawTab(2, { lastAccessed: 5, active: true })
      ])
    );
    const sessionRepository = createMemorySessionRepository();
    const runtime = await sessionRepository.loadSession();
    const observed = observeInventory(await chrome.readInventory(), runtime);
    const decision = resolveDuplicate({
      inventory: observed.inventory,
      tabs: observed.inventory.tabs,
      triggeringTab: observed.inventory.tabs.find((tab) => tab.id === 2)!,
      configuration,
      associations: [],
      session: observed.session,
      rule: null,
      destination: "ungrouped",
      destinationManaged: false,
      destinationGroup: null
    });
    expect(decision).not.toBeNull();
    const plan = planDuplicateClose(decision!, configuration, []);
    chrome.getStorage().inventory.tabs = chrome
      .getStorage()
      .inventory.tabs.map((tab) =>
        tab.id === 1 ? { ...tab, url: "https://different.example/" } : tab
      );
    const local = createMemoryLocalRepository();

    await executeActionPlan(
      plan,
      actionDeps(configuration, chrome, local, sessionRepository)
    );

    expect(chrome.callsFor("removeTabs")).toHaveLength(0);
  });

  it("does not let opener URL suffix matching cross hostname boundaries", () => {
    const tab = rawTab(7, {
      openerUrl: "https://notexample.com/from-here"
    });
    const result = evaluateCondition(
      { kind: "openerUrl", operator: "suffix", value: "example.com" },
      tab,
      inventory([tab]),
      []
    );

    expect(result.matches).toBe(false);
  });

  it("keeps a verified route successful when Activity storage fails", async () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const tab = rawTab(7, { active: true });
    const chrome = createFakeChromePort(inventory([tab]));
    const baseLocal = createMemoryLocalRepository();
    const local = {
      ...baseLocal,
      async appendActivity() {
        throw new Error("activity storage unavailable");
      }
    };
    const plan: RoutePlan = {
      kind: "routeToFallback",
      tab,
      managedGroupId: configuration.fallbackGroupId,
      groupInput: { kind: "create", tabIds: [7], windowId: 1 },
      title: "Other",
      color: "grey"
    };

    const result = await executeRoutePlan(plan, {
      chrome,
      session: createMemorySessionRepository(),
      checkpoints: { captureBefore: async () => undefined },
      local,
      configuration,
      now: () => 1_000,
      delay: async () => undefined
    });

    expect(result.kind).toBe("executed");
  });

  it("gives each duplicate-key snapshot member a distinct tab reference", async () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const raw = inventory([
      rawTab(42, { url: "https://example.com/shared" })
    ]);
    const runtime = await createMemorySessionRepository().loadSession();
    const { inventory: browserInventory } = observeInventory(raw, runtime);
    const snapshot: Snapshot = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000030" as UUID,
      name: "Unique members",
      kind: "named",
      scope: { kind: "browser" },
      groups: [
        {
          managedGroupId: configuration.fallbackGroupId,
          name: "Other A",
          color: "grey",
          collapsed: false,
          order: 0,
          tabs: [
            {
              url: "https://example.com/shared",
              title: "A",
              duplicatePolicy: { kind: "exactUrl" },
              duplicateKey: "https://example.com/shared",
              order: 0
            }
          ]
        },
        {
          managedGroupId: configuration.fallbackGroupId,
          name: "Other B",
          color: "grey",
          collapsed: false,
          order: 1,
          tabs: [
            {
              url: "https://example.com/shared",
              title: "B",
              duplicatePolicy: { kind: "exactUrl" },
              duplicateKey: "https://example.com/shared",
              order: 0
            }
          ]
        }
      ],
      createdAt: 1,
      updatedAt: 1
    };
    const { planSnapshotRestore } =
      await import("../../src/snapshots/restoreSnapshot");
    const plan = planSnapshotRestore(snapshot, browserInventory, {
      configuration,
      associations: [],
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: [],
      session: runtime
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.code);
    expect(
      plan.actions.filter((action) => action.kind === "createTab")
    ).toHaveLength(1);
    const assignments = plan.actions.filter(
      (action) => action.kind === "assignTabsToManagedGroup"
    );
    expect(assignments).toHaveLength(2);
    expect(assignments[0]?.tabs[0]).not.toEqual(assignments[1]?.tabs[0]);
  });

  it("captures live snapshot presentation from ownership instead of defaults", async () => {
    const configuration = persistenceConfiguration();
    const runtime = await createMemorySessionRepository().loadSession();
    const raw = inventory(
      [
        rawTab(7, {
          chromeGroupId: 11,
          url: "https://docs.example.com/guide"
        })
      ],
      [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue",
          collapsed: true,
          shared: false
        }
      ]
    );
    const { inventory: browserInventory } = observeInventory(raw, runtime);
    const snapshot = captureSnapshot(
      { kind: "group", managedGroupId: groupId },
      browserInventory,
      {
        configuration,
        ownership: {
          [groupId]: {
            memberUrls: ["https://docs.example.com/guide"],
            order: 7,
            collapsed: true
          }
        },
        associations: [
          {
            managedGroupId: groupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: ["https://docs.example.com/guide"],
            observedAt: 1
          }
        ]
      },
      {
        id: "00000000-0000-4000-8000-000000000031" as UUID,
        name: "Live layout",
        kind: "named",
        now: 1
      }
    );

    expect(snapshot.groups[0]?.collapsed).toBe(true);
    expect(snapshot.groups[0]?.order).toBe(7);
  });

  it("reports a degraded snapshot restore as incomplete", async () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const chrome = createFakeChromePort(
      inventory([rawTab(7, { url: "https://example.com/a" })])
    );
    chrome.setError("moveGroup", new Error("move failed"));
    const local = createMemoryLocalRepository();
    const snapshot: Snapshot = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000032" as UUID,
      name: "Partial",
      kind: "named",
      scope: { kind: "browser" },
      groups: [
        {
          managedGroupId: configuration.fallbackGroupId,
          name: "Other",
          color: "grey",
          collapsed: false,
          order: 0,
          tabs: [
            {
              url: "https://example.com/a",
              title: "A",
              duplicatePolicy: { kind: "exactUrl" },
              duplicateKey: "https://example.com/a",
              order: 0
            }
          ]
        }
      ],
      createdAt: 1,
      updatedAt: 1
    };
    await local.saveSnapshot(snapshot);
    const session = createMemorySessionRepository();

    const result = await restoreSnapshotFromRecord({
      local,
      session,
      snapshotId: snapshot.id,
      actionDeps: actionDeps(configuration, chrome, local, session)
    });

    expect(result.ok).toBe(false);
  });

  it("records automatic snapshot failures in Activity", async () => {
    const snapshots = Array.from({ length: 50 }, (_, index) =>
      namedSnapshot(index + 1)
    );
    const local = createMemoryLocalRepository({ snapshots });
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const chrome = createFakeChromePort(inventory([]));

    await handleSnapshotAlarm(SNAPSHOT_ALARMS.interval, {
      configuration: () => configuration,
      local,
      session: createMemorySessionRepository(),
      reads: chrome,
      alarms: {
        schedulePeriodic: async () => undefined,
        scheduleOneShot: async () => undefined
      },
      now: () => 1_000
    });

    const activity = await local.listActivity(undefined, 10);
    expect(activity[0]).toMatchObject({
      action: "Automatic snapshot",
      result: "failure",
      errorCode: "SNAPSHOT_LIMIT"
    });
  });

  it("rejects non-HTTP persistent canonical URLs during configuration validation", () => {
    const configuration = persistenceConfiguration();
    const invalid: Configuration = {
      ...configuration,
      persistentTabs: configuration.persistentTabs.map((tab) => ({
        ...tab,
        canonicalUrl: "ftp://example.com/file"
      }))
    };

    expect(() => validateConfiguration(invalid)).toThrow();
  });
});
