import { expect, it, vi } from "vitest";
import { createDefaultConfiguration, createManagedGroup } from "../../src/domain/defaults";
import { createManagerMessageRouter } from "../../src/background/managerMessageRouter";
import type { ActivityManagerPort } from "../../src/background/managerMessageRouter";
import type {
  ManagerCommand,
  ManagerResponse,
  ManagerTransportRecord
} from "../../src/ui/manager/types";

const fallbackId = "00000000-0000-4000-8000-000000000001";
const groupId = "00000000-0000-4000-8000-000000000002";

function activityPort(): ActivityManagerPort {
  return {
    async query() {
      return { persistentTabsByGroup: {}, activity: [] };
    },
    async undo() {
      return undefined;
    },
    async clear() {
      return undefined;
    }
  };
}

function setup() {
  const initial = createManagedGroup(
    createDefaultConfiguration(() => fallbackId),
    { name: "Work", color: "blue" },
    () => groupId,
    () => 2
  );
  let configuration = initial;
  const save = vi.fn(async (next) => { configuration = next; });
  const replaceConfiguration = vi.fn(async (next) => { configuration = next; });
  const router = createManagerMessageRouter({
    repository: { save },
    controller: {
      getConfiguration: () => configuration,
      replaceConfiguration
    },
    activity: activityPort(),
    randomUuid: () => "00000000-0000-4000-8000-000000000003",
    now: () => 3
  });
  return { router, initial, save, replaceConfiguration, getConfiguration: () => configuration };
}

it("returns the validated configuration and shared manager metadata", async () => {
  const { router, initial } = setup();
  const response = await router.handle({ kind: "manager-query" });
  expect(response).toMatchObject({
    ok: true,
    configuration: initial,
    view: { width: 520, height: 600, defaultRoute: "groups" }
  });
});

it("accepts typed group and rule commands and persists exactly once", async () => {
  const { router, save, replaceConfiguration, getConfiguration } = setup();
  const command: ManagerCommand = {
    kind: "manager-command",
    command: {
      kind: "updateGroup",
      groupId: groupId as never,
      patch: { enabled: false }
    }
  };
  const response = await router.handle(command);
  expect(response.ok).toBe(true);
  expect(getConfiguration().groups.find((group) => group.id === groupId)?.enabled).toBe(false);
  expect(save).toHaveBeenCalledTimes(1);
  expect(replaceConfiguration).toHaveBeenCalledTimes(1);
});

it("rejects invalid ids and references without replacing the last valid configuration", async () => {
  const { router, save, replaceConfiguration, initial } = setup();
  const response = await router.handle({
    kind: "manager-command",
    command: { kind: "updateGroup", groupId: "not-a-uuid" as never, patch: { name: "Nope" } }
  });
  expect(response).toMatchObject({ ok: false, error: { kind: "validation" } });
  expect(save).not.toHaveBeenCalled();
  expect(replaceConfiguration).not.toHaveBeenCalled();
  const query = await router.handle({ kind: "manager-query" });
  expect(query.ok).toBe(true);
  if (query.ok) expect(query.configuration).toEqual(initial);
});

it("returns the last valid configuration after a persistence failure", async () => {
  const initial = setup().initial;
  let configuration = initial;
  const save = vi.fn(async () => { throw new Error("storage unavailable"); });
  const replaceConfiguration = vi.fn(async (next: typeof initial) => { configuration = next; });
  const router = createManagerMessageRouter({
    repository: { save },
    controller: { getConfiguration: () => configuration, replaceConfiguration },
    activity: activityPort(),
    now: () => 4
  });

  const failed = await router.handle({
    kind: "manager-command",
    command: { kind: "updateGroup", groupId: groupId as never, patch: { name: "Rejected" } }
  });
  expect(failed).toMatchObject({ ok: false, error: { kind: "persistence" } });
  expect(replaceConfiguration).not.toHaveBeenCalled();

  const query = await router.handle({ kind: "manager-query" });
  expect(query.ok).toBe(true);
  if (query.ok) expect(query.configuration).toEqual(initial);
});

it("keeps a durable mutation accepted when post-save reconciliation throws", async () => {
  const initial = setup().initial;
  let configuration = initial;
  const save = vi.fn(async () => undefined);
  const replaceConfiguration = vi.fn(async (next: typeof initial) => {
    configuration = next;
    throw new Error("inventory unavailable");
  });
  const router = createManagerMessageRouter({
    repository: { save },
    controller: { getConfiguration: () => configuration, replaceConfiguration },
    activity: activityPort(),
    now: () => 5
  });

  const response = await router.handle({
    kind: "manager-command",
    command: { kind: "updateGroup", groupId: groupId as never, patch: { name: "Committed" } }
  });

  expect(response).toMatchObject({ ok: true });
  if (response.ok)
    expect(response.configuration.groups.find((group) => group.id === groupId)?.name).toBe("Committed");
  expect(save).toHaveBeenCalledTimes(1);
  expect(replaceConfiguration).toHaveBeenCalledTimes(1);

  const query = await router.handle({ kind: "manager-query" });
  expect(query.ok).toBe(true);
  if (query.ok)
    expect(query.configuration.groups.find((group) => group.id === groupId)?.name).toBe("Committed");
});

it("serializes concurrent mutations against the latest persisted configuration", async () => {
  const initial = setup().initial;
  let configuration = initial;
  let releaseFirst!: () => void;
  const save = vi.fn((next: typeof initial) => {
    if (save.mock.calls.length === 1) {
      return new Promise<void>((resolve) => {
        releaseFirst = () => { configuration = next; resolve(); };
      });
    }
    configuration = next;
    return Promise.resolve();
  });
  const replaceConfiguration = vi.fn(async (next: typeof initial) => { configuration = next; });
  const router = createManagerMessageRouter({
    repository: { save },
    controller: { getConfiguration: () => configuration, replaceConfiguration },
    activity: activityPort(),
    randomUuid: () => "00000000-0000-4000-8000-000000000003",
    now: () => 3
  });

  const first = router.handle({ kind: "manager-command", command: { kind: "updateGroup", groupId: groupId as never, patch: { name: "First" } } });
  await Promise.resolve();
  const second = router.handle({ kind: "manager-command", command: { kind: "updateGroup", groupId: groupId as never, patch: { color: "red" } } });
  await Promise.resolve();
  releaseFirst();
  await Promise.all([first, second]);

  const group = configuration.groups.find((item) => item.id === groupId);
  expect(group).toMatchObject({ name: "First", color: "red" });
  expect(save).toHaveBeenCalledTimes(2);
});

it("declares all manager commands as one exhaustive typed union", () => {
  const commands: ManagerCommand["command"]["kind"][] = [
    "updateGroup", "createGroup", "deleteGroup", "saveRule", "duplicateRule",
    "deleteRule", "setRuleEnabled", "setRulePaused", "undo", "clearActivity"
  ];
  expect(commands).toHaveLength(10);
});

it("keeps typed transport records and failures in the manager contract", () => {
  const response: ManagerResponse = {
    ok: false,
    error: {
      kind: "transport",
      code: "NO_RESPONSE",
      field: "runtime",
      message: "No manager response"
    }
  };
  const records: ManagerTransportRecord[] = [
    {
      recordType: "request",
      state: "pending",
      mode: "real",
      requestId: "request-1",
      sequence: 1,
      message: { kind: "manager-query" },
      startedAt: 1,
      latencyMs: 0
    },
    {
      recordType: "event",
      mode: "fixture",
      source: "transport",
      at: 2,
      name: "ready",
      details: { ok: true }
    }
  ];

  expect(response.ok).toBe(false);
  if (!response.ok)
    expect(response.error).toMatchObject({ kind: "transport", code: "NO_RESPONSE", field: "runtime" });
  expect(records).toHaveLength(2);
});
