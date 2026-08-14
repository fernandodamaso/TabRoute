import { describe, expect, it } from "vitest";
import { executeRoutePlan } from "../../src/actions/executeRoutePlan";
import { planUndoActions } from "../../src/activity/undoPlanner";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import type {
  ChromeInventory,
  Configuration,
  PersistentTab,
  Snapshot,
  UUID
} from "../../src/domain/types";
import { observeInventory } from "../../src/duplicates/observations";
import {
  calculatePersistentRepairs,
  type RestoreContext
} from "../../src/persistence/startupRestore";
import { findPersistentTabId } from "../../src/controller/executeUserCommand";
import { planSnapshotRestore } from "../../src/snapshots/restoreSnapshot";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";

const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
const managedGroupId = "00000000-0000-4000-8000-000000000002" as UUID;
const persistentId = "00000000-0000-4000-8000-000000000010" as UUID;

function persistentConfiguration(): Configuration {
  const base = createDefaultConfiguration(() => fallbackId, () => 1);
  const group = {
    ...base.groups[0]!,
    id: managedGroupId,
    name: "Docs",
    color: "blue" as const,
    isFallback: false,
    isPersistent: true,
    defaultOrder: 1
  };
  const definition: PersistentTab = {
    schemaVersion: 1,
    id: persistentId,
    managedGroupId,
    canonicalUrl: "https://docs.example.com/guide",
    acceptedPatterns: ["https://docs.example.com/guide*"],
    order: 0,
    createdAt: 1,
    updatedAt: 1
  };
  return {
    ...base,
    groups: [base.groups[0]!, group],
    persistentTabs: [definition]
  };
}

function tab(input: {
  id: number;
  windowId: number;
  url: string;
  chromeGroupId?: number;
  index?: number;
}) {
  return {
    id: input.id,
    windowId: input.windowId,
    index: input.index ?? 0,
    chromeGroupId: input.chromeGroupId ?? -1,
    url: input.url,
    status: "complete" as const,
    title: input.url,
    pinned: false,
    active: false,
    incognito: false as const,
    lastAccessed: input.id
  };
}

describe("PR 10 review regressions", () => {
  it("moves a displaced persistent tab to its home window before assigning it", () => {
    const configuration = persistentConfiguration();
    const definition = configuration.persistentTabs[0]!;
    const inventory: ChromeInventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" },
        { id: 2, focused: false, incognito: false, type: "normal" }
      ],
      tabs: [
        tab({
          id: 7,
          windowId: 2,
          url: definition.canonicalUrl
        })
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
          managedGroupId,
          chromeGroupId: 11,
          chromeWindowId: 1,
          observedTitle: "Docs",
          observedMemberUrls: [definition.canonicalUrl],
          observedAt: 1
        }
      ],
      ownership: {
        [managedGroupId]: {
          memberUrls: [definition.canonicalUrl],
          order: 0,
          collapsed: false
        }
      },
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: []
    };

    const repairs = calculatePersistentRepairs(
      definition,
      inventory,
      context,
      1
    );
    const actions = repairs[0]?.actions ?? [];
    expect(actions.map((action) => action.kind)).toEqual([
      "moveTabs",
      "assignTabsToManagedGroup"
    ]);
    const move = actions[0];
    const assign = actions[1];
    expect(move?.kind).toBe("moveTabs");
    expect(assign?.kind).toBe("assignTabsToManagedGroup");
    if (move?.kind !== "moveTabs" || assign?.kind !== "assignTabsToManagedGroup") {
      return;
    }
    expect(move.windowId).toBe(1);
    expect(assign.dependsOn).toContain(move.id);
  });

  it("moves reused snapshot tabs into the selected home before group assignment", async () => {
    const configuration = createDefaultConfiguration(() => fallbackId, () => 1);
    const raw: ChromeInventory = {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" },
        { id: 2, focused: false, incognito: false, type: "normal" }
      ],
      tabs: [
        tab({ id: 42, windowId: 1, url: "https://example.com/a" }),
        tab({ id: 43, windowId: 2, url: "https://example.com/b" })
      ],
      groups: [],
      capturedAt: 1
    };
    const session = await createMemorySessionRepository().loadSession();
    const { inventory } = observeInventory(raw, session);
    const snapshot: Snapshot = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000020" as UUID,
      name: "Cross-window",
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
              duplicateKey: null,
              order: 0
            },
            {
              url: "https://example.com/b",
              title: "B",
              duplicateKey: null,
              order: 1
            }
          ]
        }
      ],
      createdAt: 1,
      updatedAt: 1
    };

    const plan = planSnapshotRestore(snapshot, inventory, {
      configuration,
      associations: [],
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: [],
      session
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const move = plan.actions.find(
      (action) =>
        action.kind === "moveTabs" &&
        action.tabs.some((ref) => ref.kind === "live" && ref.tabId === 43)
    );
    expect(move).toBeTruthy();
    if (!move || move.kind !== "moveTabs") return;
    expect(move.windowId).toBe(1);
    const assign = plan.actions.find(
      (action) => action.kind === "assignTabsToManagedGroup"
    );
    expect(assign?.dependsOn).toContain(move.id);
  });

  it("matches accepted persistent URL patterns for menu and shortcut commands", () => {
    const configuration = persistentConfiguration();
    expect(
      findPersistentTabId(
        configuration,
        "https://docs.example.com/guide/2",
        managedGroupId
      )
    ).toBe(persistentId);
  });

  it("plans restorePlacement undo for a live routed tab", () => {
    const configuration = createDefaultConfiguration(() => fallbackId, () => 1);
    const inventory: ChromeInventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        tab({
          id: 7,
          windowId: 1,
          url: "https://example.com/",
          chromeGroupId: 11
        })
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Other",
          color: "grey",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const plan = planUndoActions({
      payload: {
        kind: "restorePlacement",
        tabId: 7,
        expectedUrl: "https://example.com/",
        placement: { kind: "ungrouped", windowIdHint: 1, index: 0 }
      },
      windowId: 1,
      configuration,
      inventory,
      associations: []
    });
    expect("status" in plan).toBe(false);
    if ("status" in plan) return;
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "ungroupTabs",
      "moveTabs"
    ]);
  });

  it("records an Undo entry for a successful automatic placement route", async () => {
    const configuration = createDefaultConfiguration(() => fallbackId, () => 1);
    const local = createMemoryLocalRepository();
    const session = createMemorySessionRepository();
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [tab({ id: 7, windowId: 1, url: "https://example.com/" })],
      groups: [],
      capturedAt: 1
    });

    await executeRoutePlan(
      {
        kind: "routeToFallback",
        tab: tab({ id: 7, windowId: 1, url: "https://example.com/" }),
        managedGroupId: configuration.fallbackGroupId,
        groupInput: { kind: "create", tabIds: [7], windowId: 1 },
        title: "Other",
        color: "grey"
      },
      {
        chrome: fake,
        session,
        checkpoints: { captureBefore: async () => undefined },
        local,
        configuration,
        now: () => 1_000,
        delay: async () => undefined
      }
    );

    const undo = await local.listUndo();
    expect(undo).toHaveLength(1);
    expect(undo[0]?.payloads[0]).toMatchObject({
      kind: "restorePlacement",
      tabId: 7,
      expectedUrl: "https://example.com/",
      placement: { kind: "ungrouped", windowIdHint: 1, index: 0 }
    });
    const activity = await local.listActivity(undefined, 10);
    expect(activity[0]?.undoId).toBe(undo[0]?.id);
  });
});
