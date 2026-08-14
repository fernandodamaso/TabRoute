import { describe, expect, it } from "vitest";
import { executeActionPlan } from "../../src/actions/executeActionPlan";
import { buildActionPlan } from "../../src/actions/buildActionPlan";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createUuid } from "../../src/domain/ids";
import type { ActionId } from "../../src/domain/types";
import { createPreMutationCheckpointService } from "../../src/snapshots/checkpointService";

describe("action engine", () => {
  it("closeDuplicate does not remove a shared-group tab", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          chromeGroupId: 10,
          url: "https://example.com/",
          title: "Survivor",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 2
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          chromeGroupId: 99,
          url: "https://example.com/",
          title: "Duplicate",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 10,
          windowId: 1,
          title: "Work",
          color: "blue",
          collapsed: false,
          shared: false
        },
        {
          id: 99,
          windowId: 1,
          title: "Shared",
          color: "grey",
          collapsed: false,
          shared: true
        }
      ],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(() => createUuid());
    const local = createMemoryLocalRepository();
    const plan = buildActionPlan("duplicate", [
      {
        id: createUuid() as unknown as ActionId,
        dependsOn: [],
        kind: "closeDuplicate",
        duplicate: { kind: "live", tabId: 2 },
        survivor: { kind: "live", tabId: 1 }
      }
    ]);
    const result = await executeActionPlan(plan, {
      reads: fake,
      mutations: fake,
      checkpoints: createPreMutationCheckpointService({
        local,
        captureContext: async () => ({
          configuration,
          ownership: {},
          associations: []
        })
      }),
      local,
      session: createMemorySessionRepository(),
      configuration,
      now: () => 1,
      delay: async () => undefined
    });
    expect(result.status).toBe("success");
    expect(fake.callsFor("removeTabs")).toEqual([]);
  });

  it("rejects CHECKPOINT_FAILED before any mutation", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://example.com/",
          title: "Tab",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 1
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          chromeGroupId: -1,
          url: "https://example.com/",
          title: "Dup",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(() => createUuid());
    const local = createMemoryLocalRepository();
    const plan = buildActionPlan("duplicate", [
      {
        id: createUuid() as unknown as ActionId,
        dependsOn: [],
        kind: "closeDuplicate",
        duplicate: { kind: "live", tabId: 2 },
        survivor: { kind: "live", tabId: 1 }
      }
    ]);
    const result = await executeActionPlan(plan, {
      reads: fake,
      mutations: fake,
      checkpoints: {
        async captureBefore() {
          throw new Error("CHECKPOINT_CAPACITY");
        }
      },
      local,
      session: createMemorySessionRepository(),
      configuration,
      now: () => 1,
      delay: async () => undefined
    });
    expect(result.status).toBe("failure");
    expect(result.errorCode).toBe("CHECKPOINT_FAILED");
    expect(fake.callsFor("removeTabs")).toEqual([]);
  });

  it("createTab output feeds assignTabsToManagedGroup via actionOutput", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(() => createUuid());
    const workId = configuration.groups[0]!.id;
    const local = createMemoryLocalRepository();
    const createId = createUuid() as unknown as ActionId;
    const assignId = createUuid() as unknown as ActionId;
    const plan = buildActionPlan(
      "undo",
      [
        {
          id: createId,
          dependsOn: [],
          kind: "createTab",
          input: { url: "https://example.com/", windowId: 1, active: false }
        },
        {
          id: assignId,
          dependsOn: [createId],
          kind: "assignTabsToManagedGroup",
          tabs: [{ kind: "actionOutput", actionId: createId }],
          managedGroupId: workId,
          windowId: 1,
          title: configuration.groups[0]!.name,
          color: configuration.groups[0]!.color
        }
      ],
      { requireCheckpoint: false }
    );
    const result = await executeActionPlan(plan, {
      reads: fake,
      mutations: fake,
      checkpoints: createPreMutationCheckpointService({
        local,
        captureContext: async () => ({
          configuration,
          ownership: {},
          associations: []
        })
      }),
      local,
      session: createMemorySessionRepository(),
      configuration,
      now: () => 1,
      delay: async () => undefined
    });
    expect(result.status).toBe("success");
    expect(fake.callsFor("createTab").length).toBe(1);
    expect(fake.callsFor("groupTabs").length).toBe(1);
  });
  it("groups every resolved member in one multi-tab mutation", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://one.example/",
          title: "One",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          chromeGroupId: -1,
          url: "https://two.example/",
          title: "Two",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(() => createUuid());
    const plan = buildActionPlan(
      "snapshot",
      [
        {
          id: createUuid() as unknown as ActionId,
          dependsOn: [],
          kind: "assignTabsToManagedGroup",
          tabs: [
            { kind: "live", tabId: 1 },
            { kind: "live", tabId: 2 }
          ],
          managedGroupId: configuration.groups[0]!.id,
          windowId: 1,
          title: configuration.groups[0]!.name,
          color: configuration.groups[0]!.color
        }
      ],
      { requireCheckpoint: false }
    );
    const local = createMemoryLocalRepository();
    const result = await executeActionPlan(plan, {
      reads: fake,
      mutations: fake,
      checkpoints: createPreMutationCheckpointService({
        local,
        captureContext: async () => ({
          configuration,
          ownership: {},
          associations: []
        })
      }),
      local,
      session: createMemorySessionRepository(),
      configuration,
      now: () => 1,
      delay: async () => undefined
    });
    expect(result.status).toBe("success");
    expect(fake.callsFor("groupTabs")[0]?.[0]).toMatchObject({
      kind: "create",
      tabIds: [1, 2]
    });
    expect(fake.getInventory().tabs.map((tab) => tab.chromeGroupId)).toEqual([
      1, 1
    ]);
    expect((await local.listActivity(undefined, 10))[0]?.result).toBe(
      "success"
    );
  });
  it("retries group presentation after grouping succeeds", async () => {
    const fake = createFakeChromePort({
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
    const configuration = createDefaultConfiguration(() => createUuid());
    const target = configuration.groups[0]!;
    let updateAttempts = 0;
    const mutations = {
      ...fake,
      async updateGroup(
        groupId: number,
        patch: Parameters<typeof fake.updateGroup>[1]
      ) {
        updateAttempts += 1;
        if (updateAttempts === 1)
          throw new Error("Tabs cannot be edited right now");
        return fake.updateGroup(groupId, patch);
      }
    };
    const local = createMemoryLocalRepository();
    const result = await executeActionPlan(
      buildActionPlan(
        "snapshot",
        [
          {
            id: createUuid() as unknown as ActionId,
            dependsOn: [],
            kind: "assignTabsToManagedGroup",
            tabs: [{ kind: "live", tabId: 1 }],
            managedGroupId: target.id,
            windowId: 1,
            title: target.name,
            color: target.color
          }
        ],
        { requireCheckpoint: false }
      ),
      {
        reads: fake,
        mutations,
        checkpoints: createPreMutationCheckpointService({
          local,
          captureContext: async () => ({
            configuration,
            ownership: {},
            associations: []
          })
        }),
        local,
        session: createMemorySessionRepository(),
        configuration,
        now: () => 1,
        delay: async () => undefined
      }
    );
    expect(result.status).toBe("success");
    expect(updateAttempts).toBe(2);
    expect(fake.getInventory().groups[0]?.title).toBe(target.name);
  });

  it("aborts a generic retry after a user changes placement", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          chromeGroupId: 10,
          url: "https://example.com/",
          title: "Example",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 10,
          windowId: 1,
          title: "Source",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    });
    let attempts = 0;
    const mutations = {
      ...fake,
      async moveTabs(
        tabIds: [number, ...number[]],
        windowId: number,
        index: number
      ) {
        attempts += 1;
        fake.getStorage().inventory.tabs = fake
          .getStorage()
          .inventory.tabs.map((tab) =>
            tabIds.includes(tab.id) ? { ...tab, index: index + 1 } : tab
          );
        throw new Error("Tabs cannot be edited right now");
      }
    };
    const configuration = createDefaultConfiguration(() => createUuid());
    const local = createMemoryLocalRepository();
    const plan = buildActionPlan(
      "snapshot",
      [
        {
          id: createUuid() as unknown as ActionId,
          dependsOn: [],
          kind: "moveTabs",
          tabs: [{ kind: "live", tabId: 1 }],
          windowId: 1,
          index: 2
        }
      ],
      { requireCheckpoint: false }
    );
    const result = await executeActionPlan(plan, {
      reads: fake,
      mutations,
      checkpoints: createPreMutationCheckpointService({
        local,
        captureContext: async () => ({
          configuration,
          ownership: {},
          associations: []
        })
      }),
      local,
      session: createMemorySessionRepository(),
      configuration,
      now: () => 1,
      delay: async () => undefined
    });
    expect(result.status).toBe("failure");
    expect(attempts).toBe(1);
  });

  it("does not removeTabs when survivor verification fails", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "",
          status: "loading",
          title: "Survivor",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 2
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          chromeGroupId: -1,
          url: "https://example.com/",
          title: "Dup",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(() => createUuid());
    const local = createMemoryLocalRepository();
    const plan = buildActionPlan("duplicate", [
      {
        id: createUuid() as unknown as ActionId,
        dependsOn: [],
        kind: "closeDuplicate",
        duplicate: { kind: "live", tabId: 2 },
        survivor: { kind: "live", tabId: 1 }
      }
    ]);
    const result = await executeActionPlan(plan, {
      reads: fake,
      mutations: fake,
      checkpoints: createPreMutationCheckpointService({
        local,
        captureContext: async () => ({
          configuration,
          ownership: {},
          associations: []
        })
      }),
      local,
      session: createMemorySessionRepository(),
      configuration,
      now: () => 1,
      delay: async () => undefined
    });
    expect(result.status).toBe("failure");
    expect(result.errorCode).toBe("SURVIVOR_INVALID");
    expect(fake.callsFor("removeTabs")).toEqual([]);
  });

  it("reorderTabs moves tabs through the mutation port", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 3,
          windowId: 1,
          index: 2,
          chromeGroupId: 10,
          url: "https://docs.example.com/guide",
          title: "Guide",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 10,
          windowId: 1,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(() => createUuid());
    const local = createMemoryLocalRepository();
    const plan = buildActionPlan("reconcile", [
      {
        id: createUuid() as unknown as ActionId,
        dependsOn: [],
        kind: "reorderTabs",
        tabs: [{ kind: "live", tabId: 3 }],
        windowId: 1,
        index: 0
      }
    ]);
    const result = await executeActionPlan(plan, {
      reads: fake,
      mutations: fake,
      checkpoints: createPreMutationCheckpointService({
        local,
        captureContext: async () => ({
          configuration,
          ownership: {},
          associations: []
        })
      }),
      local,
      session: createMemorySessionRepository(),
      configuration,
      now: () => 1,
      delay: async () => undefined
    });
    expect(result.status).toBe("success");
    expect(fake.callsFor("moveTabs")).toEqual([[[3], 1, 0]]);
  });
});
