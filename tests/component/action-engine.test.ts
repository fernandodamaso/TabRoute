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
        captureContext: async () => ({ configuration, ownership: {} })
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
});
