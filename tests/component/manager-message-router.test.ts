import { expect, it, vi } from "vitest";
import { createDefaultConfiguration, createManagedGroup } from "../../src/domain/defaults";
import { createManagerMessageRouter } from "../../src/background/managerMessageRouter";
import type { ManagerCommand } from "../../src/ui/manager/types";

const fallbackId = "00000000-0000-4000-8000-000000000001";
const groupId = "00000000-0000-4000-8000-000000000002";

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
    "deleteRule", "setRuleEnabled", "setRulePaused"
  ];
  expect(commands).toHaveLength(8);
});
