import { describe, expect, it } from "vitest";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import type {
  ChromeInventory,
  Configuration,
  PersistentTab,
  UUID
} from "../../src/domain/types";
import { runPersistentRestore } from "../../src/controller/persistentRepairRunner";
import {
  calculatePersistentRepairs,
  planPersistentRestore,
  type RestoreContext
} from "../../src/persistence/startupRestore";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";

const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
const docsId = "00000000-0000-4000-8000-000000000002" as UUID;
const persistentId = "00000000-0000-4000-8000-000000000010" as UUID;

function persistentDocsConfiguration(): Configuration {
  const base = createManagedGroup(
    createDefaultConfiguration(
      () => fallbackId,
      () => 1
    ),
    { name: "Docs", color: "blue" },
    () => docsId,
    () => 1
  );
  const definition: PersistentTab = {
    schemaVersion: 1,
    id: persistentId,
    managedGroupId: docsId,
    canonicalUrl: "https://docs.example.com/guide",
    acceptedPatterns: ["https://docs.example.com/guide"],
    order: 0,
    createdAt: 1,
    updatedAt: 1
  };
  return {
    ...base,
    groups: base.groups.map((group) =>
      group.id === docsId ? { ...group, isPersistent: true } : group
    ),
    persistentTabs: [definition],
    restorePersistentGroups: true
  };
}

function normalInventory(): ChromeInventory {
  return {
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [],
    groups: [],
    capturedAt: 1
  };
}

describe("PR 10 round 5 review regressions", () => {
  it("keeps startup restore pending when no normal window exists", async () => {
    const configuration = persistentDocsConfiguration();
    const inventory: ChromeInventory = {
      windows: [],
      tabs: [],
      groups: [],
      capturedAt: 1
    };
    const chrome = createFakeChromePort(inventory);
    const local = createMemoryLocalRepository();
    const sessionRepository = createMemorySessionRepository();
    const session = await sessionRepository.loadSession();

    await expect(
      runPersistentRestore({
        configuration,
        chrome,
        session,
        local,
        associations: [],
        actionDeps: {
          reads: chrome,
          mutations: chrome,
          checkpoints: { captureBefore: async () => undefined },
          local,
          session: sessionRepository,
          configuration,
          now: () => 1,
          delay: async () => undefined
        }
      })
    ).resolves.toBe(false);
  });

  it("plans saved ownership presentation after recreating a missing group", () => {
    const configuration = persistentDocsConfiguration();
    const inventory = normalInventory();
    const context: RestoreContext = {
      configuration,
      associations: [],
      ownership: {
        [docsId]: {
          memberUrls: ["https://docs.example.com/guide"],
          order: 4,
          collapsed: true
        }
      },
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: []
    };

    const plan = planPersistentRestore(configuration, inventory, context);
    expect(plan).not.toBeNull();
    const actions = plan!.actions;
    const assignIndex = actions.findIndex(
      (action) => action.kind === "assignTabsToManagedGroup"
    );
    const moveIndex = actions.findIndex(
      (action) => action.kind === "moveManagedGroup"
    );
    const updateIndex = actions.findIndex(
      (action) => action.kind === "updateManagedGroup"
    );

    expect(assignIndex).toBeGreaterThanOrEqual(0);
    expect(moveIndex).toBeGreaterThan(assignIndex);
    expect(updateIndex).toBeGreaterThan(assignIndex);
    expect(actions[moveIndex]).toMatchObject({
      kind: "moveManagedGroup",
      managedGroupId: docsId,
      windowId: 1,
      index: 4
    });
    expect(actions[updateIndex]).toMatchObject({
      kind: "updateManagedGroup",
      managedGroupId: docsId,
      patch: { collapsed: true }
    });
  });

  it("treats tracking and fragment variants as the existing persistent tab", () => {
    const base = persistentDocsConfiguration();
    const configuration: Configuration = {
      ...base,
      duplicateSettings: {
        ...base.duplicateSettings,
        trackingParameters: ["utm_source"]
      }
    };
    const definition = configuration.persistentTabs[0]!;
    const inventory: ChromeInventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 5,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://docs.example.com/guide?utm_source=campaign#section",
          title: "Guide",
          pinned: false,
          active: true,
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
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const context: RestoreContext = {
      configuration,
      associations: [
        {
          managedGroupId: docsId,
          chromeGroupId: 11,
          chromeWindowId: 1,
          observedTitle: "Docs",
          observedMemberUrls: [
            "https://docs.example.com/guide?utm_source=campaign#section"
          ],
          observedAt: 1
        }
      ],
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: []
    };

    expect(
      calculatePersistentRepairs(definition, inventory, context, 1)
    ).toEqual([]);
  });
});
