import { describe, expect, it } from "vitest";
import { createUuid } from "../../src/domain/ids";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import {
  clearActivity,
  getAvailableUndo
} from "../../src/activity/activityRepository";
import { planUndoRestore } from "../../src/activity/undoPlanner";

describe("activity repository", () => {
  it("returns the newest unexpired undo for the current browser session", async () => {
    const local = createMemoryLocalRepository();
    const now = 10_000;
    const browserSessionId = "session-current" as never;
    const staleSessionId = "session-old" as never;
    const fresh = planUndoRestore({
      payload: {
        kind: "restoreClosedTab",
        url: "https://example.com/",
        title: "Example",
        placement: { kind: "ungrouped", index: 0 }
      },
      session: { browserSessionId } as never,
      now,
      undoTtlMs: 30_000,
      browserSessionId,
      actionId: createUuid() as never
    });
    await local.putUndo({ ...fresh, id: createUuid(), createdAt: now - 1 });
    await local.putUndo({
      ...fresh,
      id: createUuid(),
      createdAt: now,
      expiresAt: now + 30_000
    });
    await local.putUndo({
      ...fresh,
      id: createUuid(),
      browserSessionId: staleSessionId,
      createdAt: now,
      expiresAt: now + 30_000
    });
    const available = await getAvailableUndo(local, now, browserSessionId);
    expect(available?.browserSessionId).toBe(browserSessionId);
    expect(available?.expiresAt).toBeGreaterThan(now);
  });

  it("clears activity from local storage", async () => {
    const local = createMemoryLocalRepository();
    await local.appendActivity({
      schemaVersion: 1,
      id: createUuid(),
      action: "Closed duplicate",
      result: "success",
      affectedManagedGroupIds: [],
      affectedUrls: ["https://example.com/"],
      createdAt: 1
    });
    await clearActivity(local);
    expect(await local.listActivity(undefined, 10)).toHaveLength(0);
  });
});
