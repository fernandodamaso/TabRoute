import { describe, expect, it } from "vitest";
import {
  buildExpectedActionFootprint,
  postconditionHolds
} from "../../src/actions/operationGuards";
import { executeActionPlan } from "../../src/actions/executeActionPlan";
import type { ActionPlan } from "../../src/actions/types";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import { validateConfiguration } from "../../src/domain/schemas";
import type {
  ActionId,
  ChromeInventory,
  Configuration,
  PersistentTab,
  UUID
} from "../../src/domain/types";
import {
  executeUserCommand,
  resolvePauseTarget
} from "../../src/controller/executeUserCommand";
import { pinGroupDefinitions } from "../../src/persistence/persistentCommands";
import {
  calculatePersistentRepairs,
  type RestoreContext
} from "../../src/persistence/startupRestore";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import {
  loadRestartPauseState,
  overlayRestartPauses
} from "../../src/state/restartPauses";
import { createFakeChromePort } from "../fakes/fakeChromePort";

const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
const docsId = "00000000-0000-4000-8000-000000000002" as UUID;
const persistentId = "00000000-0000-4000-8000-000000000010" as UUID;

function configurationWithDocs(): Configuration {
  return createManagedGroup(
    createDefaultConfiguration(
      () => fallbackId,
      () => 1
    ),
    { name: "Docs", color: "blue" },
    () => docsId,
    () => 1
  );
}

function emptyInventory(): ChromeInventory {
  return {
    windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
    tabs: [],
    groups: [],
    capturedAt: 1
  };
}

describe("PR 10 round 4 review regressions", () => {
  it("stores restart pauses in session while keeping portable configuration clean", async () => {
    let configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const session = createMemorySessionRepository();
    const local = createMemoryLocalRepository();
    const chrome = createFakeChromePort(emptyInventory());

    const result = await executeUserCommand(
      {
        kind: "setPause",
        target: { kind: "global" },
        duration: { kind: "restart" }
      },
      {
        getConfiguration: () => configuration,
        replaceConfiguration: async (next) => {
          configuration = next;
        },
        persistConfiguration: async (next) => {
          validateConfiguration(next);
        },
        actionDeps: () => ({
          reads: chrome,
          mutations: chrome,
          checkpoints: { captureBefore: async () => undefined },
          local,
          session,
          configuration,
          now: () => 1,
          delay: async () => undefined
        }),
        local,
        session,
        openOptionsPage: async () => undefined,
        now: () => 1
      }
    );

    expect(result).toMatchObject({ ok: true });
    expect(configuration.globalPausedUntil).toBeUndefined();
    const restartState = await loadRestartPauseState(session);
    expect(restartState.global).toBe(true);
    expect(
      resolvePauseTarget(
        overlayRestartPauses(configuration, restartState),
        undefined,
        1
      ).duration.kind
    ).toBe("resume");
  });

  it("reuses accepted persistent definitions when pinning a group", () => {
    const base = configurationWithDocs();
    const existing: PersistentTab = {
      schemaVersion: 1,
      id: persistentId,
      managedGroupId: docsId,
      canonicalUrl: "https://docs.example.com/guide",
      acceptedPatterns: ["https://docs.example.com/guide*"],
      order: 0,
      createdAt: 1,
      updatedAt: 1
    };
    const configuration: Configuration = {
      ...base,
      persistentTabs: [existing]
    };

    const next = pinGroupDefinitions(
      configuration,
      docsId,
      ["https://docs.example.com/guide/2"],
      () => 2,
      () => "00000000-0000-4000-8000-000000000099"
    );

    expect(next.persistentTabs).toHaveLength(1);
    expect(next.persistentTabs[0]?.id).toBe(persistentId);
    expect(next.persistentTabs[0]?.acceptedPatterns).toEqual(
      existing.acceptedPatterns
    );
  });

  it("requires a focus action to leave the survivor active in the focused window", () => {
    const actionId = "00000000-0000-4000-8000-000000000020" as ActionId;
    const footprint = buildExpectedActionFootprint({
      action: {
        id: actionId,
        dependsOn: [],
        kind: "focusTab",
        tab: { kind: "live", tabId: 5 },
        windowId: 1
      },
      tabIds: [5]
    });
    const inventory: ChromeInventory = {
      windows: [
        { id: 1, focused: false, incognito: false, type: "normal" },
        { id: 2, focused: true, incognito: false, type: "normal" }
      ],
      tabs: [
        {
          id: 5,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://docs.example.com/",
          title: "Docs",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    };

    expect(postconditionHolds(footprint.postcondition, inventory)).toBe(false);
  });

  it("prefers an accepted persistent tab already in the managed group", () => {
    const base = configurationWithDocs();
    const definition: PersistentTab = {
      schemaVersion: 1,
      id: persistentId,
      managedGroupId: docsId,
      canonicalUrl: "https://docs.example.com/guide",
      acceptedPatterns: ["https://docs.example.com/guide*"],
      order: 0,
      createdAt: 1,
      updatedAt: 1
    };
    const configuration: Configuration = {
      ...base,
      persistentTabs: [definition]
    };
    const inventory: ChromeInventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://docs.example.com/guide/2",
          title: "Outside",
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
          url: "https://docs.example.com/guide/3",
          title: "Inside",
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
          observedMemberUrls: ["https://docs.example.com/guide/3"],
          observedAt: 1
        }
      ],
      ownership: {},
      lastFocusedWindowId: 1,
      intentionallyClosedGroupIds: []
    };

    expect(calculatePersistentRepairs(definition, inventory, context, 1)).toEqual(
      []
    );
  });

  it("rejects malformed exact URL and opener URL rule conditions", () => {
    const base = configurationWithDocs();
    const ruleBase = {
      schemaVersion: 1 as const,
      id: "00000000-0000-4000-8000-000000000030" as UUID,
      targetGroupId: docsId,
      priority: 1,
      negative: [],
      actions: [{ kind: "group" as const }],
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    };

    expect(() =>
      validateConfiguration({
        ...base,
        rules: [
          {
            ...ruleBase,
            positive: { kind: "url", operator: "exact", value: "not-a-url" }
          }
        ]
      })
    ).toThrow();

    expect(() =>
      validateConfiguration({
        ...base,
        rules: [
          {
            ...ruleBase,
            positive: {
              kind: "openerUrl",
              operator: "exact",
              value: "still-not-a-url"
            }
          }
        ]
      })
    ).toThrow();
  });

  it("does not let Activity storage failures invalidate a completed automatic plan", async () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const chrome = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://example.com/",
          title: "Example",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    });
    const baseLocal = createMemoryLocalRepository();
    const local = {
      ...baseLocal,
      appendActivity: async () => {
        throw new Error("activity write failed");
      }
    };
    const session = createMemorySessionRepository();
    const plan: ActionPlan = {
      id: "00000000-0000-4000-8000-000000000040" as ActionId,
      source: "reconcile",
      checkpoint: "none",
      actions: [
        {
          id: "00000000-0000-4000-8000-000000000041" as ActionId,
          dependsOn: [],
          kind: "moveTabs",
          tabs: [{ kind: "live", tabId: 1 }],
          windowId: 1,
          index: 0
        }
      ]
    };

    await expect(
      executeActionPlan(plan, {
        reads: chrome,
        mutations: chrome,
        checkpoints: { captureBefore: async () => undefined },
        local,
        session,
        configuration,
        now: () => 1,
        delay: async () => undefined
      })
    ).resolves.toMatchObject({ status: "success" });
  });
});
