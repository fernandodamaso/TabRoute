import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createUuid } from "../../src/domain/ids";
import { executeUndo } from "../../src/activity/executeUndo";
import { planUndoActions } from "../../src/activity/undoPlanner";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createPreMutationCheckpointService } from "../../src/snapshots/checkpointService";
import { planUndoRestore } from "../../src/activity/undoPlanner";
import type { ActionId, BrowserSessionId, UUID } from "../../src/domain/types";

const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;

function undoDeps(fake: ReturnType<typeof createFakeChromePort>) {
  const configuration = createDefaultConfiguration(() => fallbackId);
  const local = createMemoryLocalRepository();
  const session = createMemorySessionRepository();
  return {
    configuration,
    local,
    session,
    deps: {
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
      session,
      configuration,
      now: () => 10_000,
      delay: async () => undefined
    }
  };
}

describe("activity undo", () => {
  it("restores the exact duplicate even after another tab closes", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    fake.getStorage().recentlyClosed = [
      {
        sessionId: "closed-duplicate-7",
        url: "https://example.com/page",
        title: "Example",
        lastAccessed: 1
      },
      {
        sessionId: "closed-other",
        url: "https://other.test/",
        title: "Other",
        lastAccessed: 2
      }
    ];
    const { configuration, local, session, deps } = undoDeps(fake);
    const runtime = await session.loadSession();
    const undoId = createUuid();
    await local.putUndo({
      ...planUndoRestore({
        payload: {
          kind: "restoreClosedTab",
          sessionId: "closed-duplicate-7",
          url: "https://example.com/page",
          title: "Example",
          placement: { kind: "ungrouped", windowIdHint: 1, index: 0 }
        },
        session: runtime,
        now: 10_000,
        undoTtlMs: 30_000,
        browserSessionId: runtime.browserSessionId,
        actionId: createUuid() as unknown as ActionId
      }),
      id: undoId
    });

    const result = await executeUndo({
      undoId,
      local,
      session,
      deps,
      configuration,
      now: () => 10_000
    });

    expect(result).toBe("success");
    expect(fake.callsFor("restoreClosedTab")).toEqual([["closed-duplicate-7"]]);
    expect(fake.callsFor("moveTabs").length).toBeGreaterThan(0);
  });

  it("returns unavailable for a mismatched browserSessionId", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    const { configuration, local, session, deps } = undoDeps(fake);
    const undoId = createUuid();
    await local.putUndo({
      ...planUndoRestore({
        payload: {
          kind: "restoreClosedTab",
          url: "https://example.com/",
          title: "Example",
          placement: { kind: "ungrouped", index: 0 }
        },
        session: {
          browserSessionId: "other-session" as BrowserSessionId
        } as never,
        now: 10_000,
        undoTtlMs: 30_000,
        browserSessionId: "other-session" as BrowserSessionId,
        actionId: createUuid() as unknown as ActionId
      }),
      id: undoId
    });

    expect(
      await executeUndo({
        undoId,
        local,
        session,
        deps,
        configuration,
        now: () => 10_000
      })
    ).toBe("unavailable");
  });

  it("returns expired for an expired undo record", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    const { configuration, local, session, deps } = undoDeps(fake);
    const runtime = await session.loadSession();
    const undoId = createUuid();
    await local.putUndo({
      schemaVersion: 1,
      id: undoId,
      actionId: createUuid() as unknown as ActionId,
      browserSessionId: runtime.browserSessionId,
      payloads: [
        {
          kind: "restoreClosedTab",
          url: "https://example.com/",
          title: "Example",
          placement: { kind: "ungrouped", index: 0 }
        }
      ],
      expiresAt: 5_000,
      createdAt: 1
    });

    expect(
      await executeUndo({
        undoId,
        local,
        session,
        deps,
        configuration,
        now: () => 10_000
      })
    ).toBe("expired");
  });

  it("returns unavailable when no normal window exists", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: true, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    const { configuration, local, session, deps } = undoDeps(fake);
    const runtime = await session.loadSession();
    const undoId = createUuid();
    await local.putUndo({
      ...planUndoRestore({
        payload: {
          kind: "restoreClosedTab",
          url: "https://example.com/",
          title: "Example",
          placement: { kind: "ungrouped", index: 0 }
        },
        session: runtime,
        now: 10_000,
        undoTtlMs: 30_000,
        browserSessionId: runtime.browserSessionId,
        actionId: createUuid() as unknown as ActionId
      }),
      id: undoId
    });

    expect(
      await executeUndo({
        undoId,
        local,
        session,
        deps,
        configuration,
        now: () => 10_000
      })
    ).toBe("unavailable");
  });

  it("rejects undo after worker recreation when browserSessionId changes", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    const { configuration, local, session, deps } = undoDeps(fake);
    const runtime = await session.loadSession();
    const undoId = createUuid();
    await local.putUndo({
      ...planUndoRestore({
        payload: {
          kind: "restoreClosedTab",
          url: "https://example.com/",
          title: "Example",
          placement: { kind: "ungrouped", index: 0 }
        },
        session: runtime,
        now: 10_000,
        undoTtlMs: 30_000,
        browserSessionId: runtime.browserSessionId,
        actionId: createUuid() as unknown as ActionId
      }),
      id: undoId
    });
    await session.saveSession({
      ...runtime,
      browserSessionId: "session-after-restart" as BrowserSessionId
    });

    expect(
      await executeUndo({
        undoId,
        local,
        session,
        deps,
        configuration,
        now: () => 10_000
      })
    ).toBe("unavailable");
  });

  it("plans managed-group placement after restoreClosedTab", () => {
    const configuration = createDefaultConfiguration(() => fallbackId);
    const workId = configuration.groups[0]!.id;
    const plan = planUndoActions({
      payload: {
        kind: "restoreClosedTab",
        sessionId: "closed-1",
        url: "https://example.com/",
        title: "Example",
        placement: {
          kind: "managedGroup",
          managedGroupId: workId,
          windowIdHint: 1,
          index: 0
        }
      },
      windowId: 1,
      configuration,
      inventory: {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 1
      },
      associations: []
    });
    expect("status" in plan).toBe(false);
    if ("status" in plan) return;
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "restoreClosedTab",
      "assignTabsToManagedGroup",
      "moveTabs"
    ]);
    const move = plan.actions[2];
    expect(move?.kind).toBe("moveTabs");
    if (move?.kind !== "moveTabs") return;
    expect(move.index).toBe(0);
  });
});
