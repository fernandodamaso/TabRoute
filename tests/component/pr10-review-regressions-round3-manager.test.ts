import { describe, expect, it, vi } from "vitest";
import { createManagerMessageRouter } from "../../src/background/managerMessageRouter";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import type { Configuration, UUID } from "../../src/domain/types";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";

const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
const workId = "00000000-0000-4000-8000-000000000002" as UUID;
const ruleId = "00000000-0000-4000-8000-000000000010" as UUID;

function configurationWithRule(): Configuration {
  const grouped = createManagedGroup(
    createDefaultConfiguration(
      () => fallbackId,
      () => 1
    ),
    { name: "Work", color: "blue" },
    () => workId,
    () => 1
  );
  return {
    ...grouped,
    rules: [
      {
        schemaVersion: 1,
        id: ruleId,
        targetGroupId: workId,
        priority: 1,
        positive: { kind: "host", operator: "suffix", value: "example.com" },
        negative: [],
        actions: [{ kind: "group" }],
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  };
}

function makeRouter(input: {
  initial: Configuration;
  session: ReturnType<typeof createMemorySessionRepository>;
  applyGroupPresentation?: ReturnType<typeof vi.fn>;
}) {
  let current = input.initial;
  const router = createManagerMessageRouter({
    repository: {
      save: async (next) => {
        current = next;
      }
    },
    controller: {
      getConfiguration: () => current,
      replaceConfiguration: async (next) => {
        current = next;
      }
    },
    activity: {
      query: async () => ({ persistentTabsByGroup: {} }),
      undo: async () => "success",
      clear: async () => undefined
    },
    snapshots: {
      query: async () => ({ persistentTabsByGroup: {} }),
      save: async () => ({ ok: true, configuration: current, view: {
        width: 520, height: 600, headerHeight: 52, navigationHeight: 42,
        defaultRoute: "groups", routes: ["groups", "rules", "activity", "settings"]
      } }),
      restore: async () => ({ ok: true, configuration: current, view: {
        width: 520, height: 600, headerHeight: 52, navigationHeight: 42,
        defaultRoute: "groups", routes: ["groups", "rules", "activity", "settings"]
      } }),
      update: async () => ({ ok: true, configuration: current, view: {
        width: 520, height: 600, headerHeight: 52, navigationHeight: 42,
        defaultRoute: "groups", routes: ["groups", "rules", "activity", "settings"]
      } }),
      rename: async () => ({ ok: true, configuration: current, view: {
        width: 520, height: 600, headerHeight: 52, navigationHeight: 42,
        defaultRoute: "groups", routes: ["groups", "rules", "activity", "settings"]
      } }),
      delete: async () => ({ ok: true, configuration: current, view: {
        width: 520, height: 600, headerHeight: 52, navigationHeight: 42,
        defaultRoute: "groups", routes: ["groups", "rules", "activity", "settings"]
      } })
    },
    diagnostics: {
      query: async () => ({ persistentTabsByGroup: {} }),
      recheck: async () => ({ persistentTabsByGroup: {} }),
      retryPendingSync: async () => ({ persistentTabsByGroup: {} }),
      reconcileAll: async () => undefined,
      exportActivityLog: async () => ({ persistentTabsByGroup: {} })
    },
    session: input.session,
    applyGroupPresentation: input.applyGroupPresentation as never,
    randomUuid: () => "00000000-0000-4000-8000-000000000099"
  });
  return { router, getCurrent: () => current };
}

describe("PR 10 manager restart-pause and presentation regressions", () => {
  it("keeps restart rule pauses in session state and out of portable config", async () => {
    const session = createMemorySessionRepository();
    const { router, getCurrent } = makeRouter({
      initial: configurationWithRule(),
      session
    });

    const paused = await router.handle({
      kind: "manager-command",
      command: { kind: "setRulePaused", ruleId, pausedUntil: "restart" }
    });

    expect(paused.ok).toBe(true);
    if (paused.ok) {
      expect(paused.configuration.rules[0]?.pausedUntil).toBe("restart");
    }
    expect(getCurrent().rules[0]?.pausedUntil).toBeUndefined();

    const exported = await router.handle({
      kind: "manager-command",
      command: { kind: "exportConfiguration" }
    });
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      expect(exported.configuration.rules[0]?.pausedUntil).toBe("restart");
      expect(exported.viewFixture?.activityLogExport).not.toContain("restart");
    }

    const sameSessionQuery = await router.handle({ kind: "manager-query" });
    expect(sameSessionQuery.ok).toBe(true);
    if (sameSessionQuery.ok) {
      expect(sameSessionQuery.configuration.rules[0]?.pausedUntil).toBe("restart");
    }

    const restarted = makeRouter({
      initial: getCurrent(),
      session: createMemorySessionRepository()
    });
    const afterRestart = await restarted.router.handle({ kind: "manager-query" });
    expect(afterRestart.ok).toBe(true);
    if (afterRestart.ok) {
      expect(afterRestart.configuration.rules[0]?.pausedUntil).toBeUndefined();
    }
  });

  it("calls the live presentation hook after a durable identity edit", async () => {
    const applyGroupPresentation = vi.fn(async () => undefined);
    const { router } = makeRouter({
      initial: configurationWithRule(),
      session: createMemorySessionRepository(),
      applyGroupPresentation
    });

    const result = await router.handle({
      kind: "manager-command",
      command: { kind: "updateGroup", groupId: workId, patch: { name: "Deep Work" } }
    });

    expect(result.ok).toBe(true);
    expect(applyGroupPresentation).toHaveBeenCalledTimes(1);
    expect(applyGroupPresentation.mock.calls[0]?.[0]).toMatchObject({
      groupId: workId,
      previousConfiguration: {
        groups: expect.arrayContaining([expect.objectContaining({ id: workId, name: "Work" })])
      },
      nextConfiguration: {
        groups: expect.arrayContaining([expect.objectContaining({ id: workId, name: "Deep Work" })])
      }
    });
  });
});
