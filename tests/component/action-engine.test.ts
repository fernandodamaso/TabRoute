import { describe, expect, it } from "vitest";
import { buildActionPlan } from "../../src/actions/buildActionPlan";
import { executeActionPlan } from "../../src/actions/executeActionPlan";
import type { ActionPlan, PlannedAction } from "../../src/actions/types";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createUuid } from "../../src/domain/ids";
import type { ActionId, UUID } from "../../src/domain/types";
import { createPreMutationCheckpointService } from "../../src/snapshots/checkpointService";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";

const groupId = "00000000-0000-4000-8000-000000000002" as UUID;

function action(
  kind: PlannedAction["kind"],
  overrides: Partial<PlannedAction> = {}
): PlannedAction {
  const id = createUuid() as unknown as ActionId;
  const base = { id, dependsOn: [] as ActionId[] };
  switch (kind) {
    case "createTab":
      return {
        ...base,
        kind: "createTab",
        input: { url: "https://example.com/", windowId: 1, active: false },
        ...overrides
      } as PlannedAction;
    case "closeDuplicate":
      return {
        ...base,
        kind: "closeDuplicate",
        duplicate: { kind: "live", tabId: 2 },
        survivor: { kind: "live", tabId: 1 },
        ...overrides
      } as PlannedAction;
    case "ungroupTabs":
      return {
        ...base,
        kind: "ungroupTabs",
        tabs: [{ kind: "live", tabId: 1 }],
        ...overrides
      } as PlannedAction;
    case "assignTabsToManagedGroup":
      return {
        ...base,
        kind: "assignTabsToManagedGroup",
        tabs: [{ kind: "live", tabId: 1 }],
        managedGroupId: groupId,
        windowId: 1,
        title: "Work",
        color: "blue",
        ...overrides
      } as PlannedAction;
    default:
      throw new Error(`unsupported kind ${kind}`);
  }
}

function engineDeps(
  fake: ReturnType<typeof createFakeChromePort>,
  configuration = createDefaultConfiguration(() => createUuid())
) {
  const local = createMemoryLocalRepository();
  return {
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
  };
}

describe("action engine", () => {
  it("creates tabs through the mutation port", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    const plan = buildActionPlan("snapshot", [action("createTab")]);
    const result = await executeActionPlan(plan, engineDeps(fake));
    expect(result.status).toBe("success");
    expect(fake.callsFor("createTab")).toHaveLength(1);
  });

  it("requires checkpoint before destructive plans", async () => {
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
        }
      ],
      capturedAt: 1
    });
    const configuration = createDefaultConfiguration(() => createUuid());
    const local = createMemoryLocalRepository();
    const plan: ActionPlan = buildActionPlan("reconcile", [
      action("ungroupTabs")
    ]);
    const result = await executeActionPlan(plan, {
      ...engineDeps(fake, configuration),
      checkpoints: {
        captureBefore: async () => {
          throw new Error("checkpoint failed");
        }
      },
      local
    });
    expect(result.status).toBe("failure");
    expect(result.errorCode).toBe("CHECKPOINT_FAILED");
    expect(fake.callsFor("ungroupTabs")).toEqual([]);
  });

  it("assigns tabs to managed groups and updates presentation", async () => {
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
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    });
    let configuration = createDefaultConfiguration(() => createUuid());
    configuration = {
      ...configuration,
      groups: [
        ...configuration.groups,
        {
          schemaVersion: 1,
          id: groupId,
          name: "Work",
          color: "blue",
          isFallback: false,
          enabled: true,
          isPersistent: false,
          defaultOrder: 0,
          defaultCollapsed: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    };
    const plan = buildActionPlan("snapshot", [
      action("assignTabsToManagedGroup")
    ]);
    const result = await executeActionPlan(plan, engineDeps(fake, configuration));
    expect(result.status).toBe("success");
    expect(fake.callsFor("groupTabs")).toHaveLength(1);
    expect(fake.callsFor("updateGroup")).toHaveLength(1);
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
    expect(result.errorCode).toBe("POSTCONDITION_FAILED");
    expect(fake.callsFor("removeTabs")).toEqual([]);
  });

  it("reorderTabs moves tabs through the mutation port", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 3,
          windowId: 1,
          index: 0,
          chromeGroupId: 10,
          url: "https://docs.example.com/guide",
          title: "Guide",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        },
        {
          id: 4,
          windowId: 1,
          index: 1,
          chromeGroupId: 10,
          url: "https://docs.example.com/api",
          title: "API",
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
        }
      ],
      capturedAt: 1
    });
    const plan = buildActionPlan("snapshot", [
      {
        id: createUuid() as unknown as ActionId,
        dependsOn: [],
        kind: "reorderTabs",
        tabs: [
          { kind: "live", tabId: 4 },
          { kind: "live", tabId: 3 }
        ],
        windowId: 1,
        index: 0
      }
    ]);
    const result = await executeActionPlan(plan, engineDeps(fake));
    expect(result.status).toBe("success");
    expect(fake.callsFor("moveTabs")).toHaveLength(1);
  });
});
