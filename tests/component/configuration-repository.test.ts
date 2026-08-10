import { createConfigurationRepository } from "../../src/state/configurationRepository";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { encodeConfigurationRevision, sha256 } from "../../src/state/configurationShards";
import {
  CONFIGURATION_SYNC_RETRY_ALARM,
  createConfigurationSyncCoordinator,
  registerConfigurationSyncIntake
} from "../../src/state/configurationSyncCoordinator";
import { createChromeSessionRepository } from "../../src/state/sessionRepository";
import type { UUID } from "../../src/domain/types";

const secondGroupId = "00000000-0000-4000-8000-000000000002" as UUID;

function chromeStorage(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  const writes: Record<string, unknown>[] = [];
  const area = {
    values,
    writes,
    async get(keys?: string | readonly string[]) {
      if (keys === undefined) return { ...values };
      const requested = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(
        requested.filter((key) => key in values).map((key) => [key, values[key]])
      );
    },
    async set(next: Record<string, unknown>) {
      writes.push(next);
      Object.assign(values, next);
    },
    async remove(keys: string | readonly string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete values[key];
    },
    async getBytesInUse() {
      return JSON.stringify(values).length;
    }
  };
  return area;
}

function storage() {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(key: string) { return key in values ? { [key]: values[key] } : {}; },
    async set(value: Record<string, unknown>) { Object.assign(values, value); }
  };
}

it("keeps the fallback UUID across a fresh repository instance", async () => {
  const local = storage();
  let next = 0;
  const createDefault = () => createDefaultConfiguration(() => `00000000-0000-4000-8000-00000000000${++next}`);
  const first = await createConfigurationRepository({ storage: local, createDefault }).loadOrCreate();
  const second = await createConfigurationRepository({ storage: local, createDefault }).loadOrCreate();

  expect(second.fallbackGroupId).toBe(first.fallbackGroupId);
  expect(JSON.stringify(local.values)).not.toContain("chromeGroupId");
  expect(JSON.stringify(local.values)).not.toContain("windowId");
});

it("normalizes schema-v1 groups additively and writes the normalized value once", async () => {
  const local = storage();
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const legacy = structuredClone(configuration) as unknown as Record<string, unknown>;
  const legacyGroups = (legacy.groups as Array<Record<string, unknown>>).map(
    ({ enabled: _enabled, ...group }) => group
  );
  legacy.groups = legacyGroups;
  local.values["config:v1"] = legacy;

  let writes = 0;
  const originalSet = local.set;
  local.set = async (value) => {
    writes += 1;
    await originalSet(value);
  };
  const loaded = await createConfigurationRepository({ storage: local }).loadOrCreate();

  expect(loaded.groups[0]?.enabled).toBe(true);
  expect(loaded.fallbackGroupId).toBe(configuration.fallbackGroupId);
  expect(loaded.rules).toEqual(configuration.rules);
  expect((local.values["config:v1"] as ConfigurationLike).groups[0]?.enabled).toBe(true);
  expect(writes).toBe(1);
});

type ConfigurationLike = { groups: Array<{ enabled?: boolean }> };

it("migrates a legacy configuration without enabled and preserves UUIDs and rules", async () => {
  const base = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const legacy = {
    ...base,
    groups: [
      {
        ...base.groups[0]!,
        enabled: undefined
      },
      {
        schemaVersion: 1,
        id: secondGroupId,
        name: "Docs",
        color: "blue",
        isFallback: false,
        isPersistent: false,
        defaultOrder: 1,
        defaultCollapsed: false,
        createdAt: 1,
        updatedAt: 1,
        enabled: undefined
      }
    ],
    rules: [
      {
        schemaVersion: 1,
        id: "00000000-0000-4000-8000-000000000003" as UUID,
        targetGroupId: secondGroupId,
        priority: 1,
        positive: { kind: "host", operator: "exact", value: "docs.example.com" },
        negative: [],
        actions: [{ kind: "group" }],
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  };
  const sync = chromeStorage();
  const local = chromeStorage({ "config:v1": legacy });
  const session = chromeStorage();
  const repository = createConfigurationRepository({
    storage: { sync, local, session },
    createDefault: () => base
  });

  const migrated = await repository.loadOrCreate();

  expect(migrated.fallbackGroupId).toBe(base.fallbackGroupId);
  expect(migrated.groups.map((group) => group.id)).toEqual([
    base.fallbackGroupId,
    secondGroupId
  ]);
  expect(migrated.groups.every((group) => group.enabled === true)).toBe(true);
  expect(migrated.rules).toEqual(legacy.rules);
  expect(local.values["config:v1"]).toBeUndefined();
  expect(sync.values["config:v1:head"]).toBeDefined();
  expect(local.values["config-shadow:v1"]).toBeDefined();
});

it("publishes shards before the head and keeps only portable configuration in Sync", async () => {
  const sync = chromeStorage();
  const local = chromeStorage();
  const session = chromeStorage();
  const repository = createConfigurationRepository({
    storage: { sync, local, session },
    createDefault: () =>
      createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001")
  });

  const configuration = await repository.loadOrCreate();
  const syncKeys = Object.keys(sync.values);
  const headIndex = sync.writes.findIndex((write) => "config:v1:head" in write);
  const shardIndexes = sync.writes
    .map((write, index) =>
      Object.keys(write).some((key) => key.startsWith("config:v1:revision:"))
        ? index
        : -1
    )
    .filter((index) => index >= 0);

  expect(syncKeys).toContain("config:v1:head");
  expect(syncKeys.some((key) => /^config:v1:revision:[^:]+:\d+$/.test(key))).toBe(true);
  expect(headIndex).toBeGreaterThan(Math.max(...shardIndexes));
  expect(Object.values(sync.values).join(" ")).not.toContain("chromeGroupId");
  expect(Object.values(sync.values).join(" ")).not.toContain("windowId");
  expect(JSON.stringify(local.values["config-shadow:v1"])).toContain(
    configuration.fallbackGroupId
  );
  expect(Object.keys(session.values)).toContain("runtime:v1");
});

it("does not apply an incomplete remote generation and applies it once when the last shard arrives", async () => {
  const base = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const sync = chromeStorage();
  const local = chromeStorage();
  const session = chromeStorage();
  const repository = createConfigurationRepository({
    storage: { sync, local, session },
    createDefault: () => base
  });
  await repository.loadOrCreate();

  const remote = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000004"
  );
  const remoteRepository = createConfigurationRepository({
    storage: { sync, local: chromeStorage(), session: chromeStorage() },
    createDefault: () => remote
  });
  await remoteRepository.save(remote);
  const remoteHead = sync.values["config:v1:head"] as { revisionId: string; shardKeys: string[] };
  const lastKey = remoteHead.shardKeys.at(-1)!;
  const lastShard = sync.values[lastKey];
  delete sync.values[lastKey];

  const pending = await repository.applySyncChange(["config:v1:head"]);
  expect(pending.kind).toBe("pending");
  expect(repository.getConfiguration()).toEqual(base);

  sync.values[lastKey] = lastShard;
  const applied = await repository.applySyncChange([lastKey]);
  expect(applied.kind).toBe("applied");
  expect(repository.getConfiguration().fallbackGroupId).toBe(remote.fallbackGroupId);
  await repository.markControllerRevisionApplied(remoteHead.revisionId);

  const echo = await repository.applySyncChange(["config:v1:head"]);
  expect(echo.kind).toBe("already-applied");
  expect(echo.configuration.fallbackGroupId).toBe(remote.fallbackGroupId);
});

it("keeps an incomplete remote head pending on a new device without publishing defaults", async () => {
  const base = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000061"
  );
  const remote = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000062"
  );
  const encoded = await encodeConfigurationRevision(
    remote,
    "00000000-0000-4000-8000-000000000063"
  );
  const sync = chromeStorage({ "config:v1:head": encoded.head });
  const local = chromeStorage();
  const session = chromeStorage();
  const repository = createConfigurationRepository({
    storage: { sync, local, session },
    createDefault: () => base
  });

  const loaded = await repository.loadOrCreate();

  expect(loaded.fallbackGroupId).toBe(base.fallbackGroupId);
  expect(sync.values["config:v1:head"]).toEqual(encoded.head);
  expect(sync.writes).toEqual([]);
  expect(local.values["config:v1"]).toBeUndefined();
  expect(session.values["runtime:v1"]).toMatchObject({
    pendingSyncRevision: encoded.head.revisionId
  });
});

it("preserves revision markers and associations through one serialized Session record", async () => {
  const storage = chromeStorage();
  const session = createChromeSessionRepository(storage);
  const associations = [
    {
      managedGroupId: "00000000-0000-4000-8000-000000000071" as UUID,
      chromeGroupId: 7,
      chromeWindowId: 8,
      observedAt: 9
    }
  ];

  await session.updateRuntime({ lastAppliedSyncRevisionId: "revision-a" });
  await session.saveAssociations(associations);
  await session.updateRuntime({ pendingSyncRevision: "revision-b" });

  expect(storage.values["runtime:v1"]).toEqual({
    lastAppliedSyncRevisionId: "revision-a",
    pendingSyncRevision: "revision-b",
    associations
  });
  await expect(session.loadAssociations()).resolves.toEqual(associations);
});

it("rejects a Sync quota failure without replacing the last-valid shadow", async () => {
  const sync = chromeStorage();
  const local = chromeStorage();
  const session = chromeStorage();
  const repository = createConfigurationRepository({
    storage: { sync, local, session },
    createDefault: () =>
      createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001")
  });
  const initial = await repository.loadOrCreate();
  const previousHead = structuredClone(sync.values["config:v1:head"]);
  sync.set = async () => {
    throw new Error("QUOTA_BYTES_PER_ITEM");
  };

  await expect(
    repository.save({ ...initial, updatedAt: initial.updatedAt + 1 })
  ).rejects.toMatchObject({ code: "SYNC_ITEM_QUOTA" });
  expect(sync.values["config:v1:head"]).toEqual(previousHead);
  expect(repository.getConfiguration()).toEqual(initial);
  expect(local.values["config-shadow:v1"]).toBeDefined();
});

it("returns the valid legacy configuration when Sync migration persistence fails", async () => {
  const legacy = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000011"
  );
  const fallback = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000012"
  );
  const sync = chromeStorage();
  sync.set = async () => {
    throw new Error("QUOTA_BYTES");
  };
  const local = chromeStorage({ "config:v1": legacy });
  const repository = createConfigurationRepository({
    storage: { sync, local, session: chromeStorage() },
    createDefault: () => fallback
  });

  const loaded = await repository.loadOrCreate();

  expect(loaded.fallbackGroupId).toBe(legacy.fallbackGroupId);
  expect(local.values["config:v1"]).toEqual(legacy);
});

it("rejects a Local shadow with an invalid checksum before using it for recovery", async () => {
  const shadowConfiguration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000021"
  );
  const fallback = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000022"
  );
  const local = chromeStorage({
    "config-shadow:v1": {
      schemaVersion: 1,
      revisionId: "legacy-revision",
      checksum: "not-a-sha256",
      configuration: shadowConfiguration,
      updatedAt: 1
    }
  });
  const repository = createConfigurationRepository({
    storage: { sync: chromeStorage(), local, session: chromeStorage() },
    createDefault: () => fallback
  });

  const loaded = await repository.loadOrCreate();

  expect(loaded.fallbackGroupId).toBe(fallback.fallbackGroupId);
});

it("does not switch active configuration until remote shadow and Session markers persist", async () => {
  const initial = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000031"
  );
  const remote = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000032"
  );
  const sync = chromeStorage();
  const local = chromeStorage();
  const session = chromeStorage();
  const repository = createConfigurationRepository({
    storage: { sync, local, session },
    createDefault: () => initial
  });
  await repository.loadOrCreate();
  const remoteRepository = createConfigurationRepository({
    storage: { sync, local: chromeStorage(), session: chromeStorage() },
    createDefault: () => remote
  });
  await remoteRepository.save(remote);
  const originalSessionSet = session.set;
  session.set = async (next) => {
    if (JSON.stringify(next).includes("lastAppliedSyncRevisionId"))
      throw new Error("SESSION_WRITE");
    await originalSessionSet(next);
  };

  await expect(repository.applySyncChange(["config:v1:head"])).rejects.toThrow(
    "SESSION_WRITE"
  );
  expect(repository.getConfiguration().fallbackGroupId).toBe(
    initial.fallbackGroupId
  );

  session.set = originalSessionSet;
  const retried = await repository.applySyncChange(["config:v1:head"]);
  expect(retried.kind).toBe("applied");
  expect(repository.getConfiguration().fallbackGroupId).toBe(
    remote.fallbackGroupId
  );
});

it("keeps a committed save successful when obsolete shard cleanup fails", async () => {
  const sync = chromeStorage();
  const local = chromeStorage();
  const session = chromeStorage();
  const repository = createConfigurationRepository({
    storage: { sync, local, session },
    createDefault: () =>
      createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000081")
  });
  const initial = await repository.loadOrCreate();
  const previousHead = sync.values["config:v1:head"] as { revisionId: string; shardKeys: string[] };
  const originalRemove = sync.remove;
  sync.remove = async (keys) => {
    if ((typeof keys === "string" ? [keys] : keys).some((key) => previousHead.shardKeys.includes(key)))
      throw new Error("cleanup unavailable");
    await originalRemove(keys);
  };

  const next = { ...initial, updatedAt: initial.updatedAt + 1 };
  await expect(repository.save(next)).resolves.toBeUndefined();
  expect((sync.values["config:v1:head"] as { revisionId: string }).revisionId).not.toBe(
    previousHead.revisionId
  );
  expect(repository.getConfiguration()).toEqual(next);
});

it("rejects a checksum-valid remote payload with unknown fields", async () => {
  const initial = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000041"
  );
  const remote = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000042"
  );
  const sync = chromeStorage();
  const repository = createConfigurationRepository({
    storage: { sync, local: chromeStorage(), session: chromeStorage() },
    createDefault: () => initial
  });
  await repository.loadOrCreate();
  const encoded = await encodeConfigurationRevision(
    remote,
    "00000000-0000-4000-8000-000000000052"
  );
  const shardKey = encoded.head.shardKeys[0]!;
  const shard = structuredClone(encoded.shards[shardKey]!);
  const raw = JSON.parse(shard.payload) as Record<string, unknown>;
  raw.unknownField = "must-reject";
  shard.payload = JSON.stringify(raw);
  encoded.head.checksum = await sha256(shard.payload);
  sync.values[shardKey] = shard;
  sync.values["config:v1:head"] = encoded.head;

  const result = await repository.applySyncChange(["config:v1:head"]);

  expect(result.kind).toBe("invalid");
  expect(repository.getConfiguration().fallbackGroupId).toBe(
    initial.fallbackGroupId
  );
});

it("coordinates one complete remote apply across controller and future side effects exactly once", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000051"
  );
  let applyCount = 0;
  const calls: string[] = [];
  const coordinator = createConfigurationSyncCoordinator({
    repository: {
      async applySyncChange() {
        applyCount += 1;
        return applyCount === 1
          ? { kind: "applied" as const, configuration, revisionId: "remote" }
          : { kind: "already-applied" as const, configuration, revisionId: "remote" };
      },
      async markControllerRevisionApplied() {}
    },
    callbacks: {
      async replaceConfiguration() { calls.push("controller"); },
      async refreshMenus() { calls.push("menus"); },
      async refreshAlarms() { calls.push("alarms"); },
      async refreshViews() { calls.push("views"); },
      async scheduleRetry() {}
    }
  });

  await coordinator.applySyncChange(["config:v1:head"]);
  await coordinator.applySyncChange(["config:v1:revision:remote:0"]);

  expect(calls).toEqual(["controller", "menus", "alarms", "views"]);
});

it("retries all controller side effects after a callback failure", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000091"
  );
  let acknowledged = false;
  let replaceCalls = 0;
  const coordinator = createConfigurationSyncCoordinator({
    repository: {
      async applySyncChange() {
        return acknowledged
          ? { kind: "already-applied" as const, configuration, revisionId: "revision" }
          : { kind: "applied" as const, configuration, revisionId: "revision" };
      },
      async markControllerRevisionApplied() {
        acknowledged = true;
      }
    },
    callbacks: {
      async replaceConfiguration() {
        replaceCalls += 1;
        if (replaceCalls === 1) throw new Error("controller unavailable");
      },
      async refreshMenus() {},
      async refreshAlarms() {},
      async refreshViews() {},
      async scheduleRetry() {}
    }
  });

  await expect(coordinator.applySyncChange()).rejects.toThrow("controller unavailable");
  await expect(coordinator.applySyncChange()).resolves.toMatchObject({ kind: "applied" });
  expect(replaceCalls).toBe(2);
  expect(acknowledged).toBe(true);
});

it("schedules the named durable alarm when a remote revision is pending", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000101"
  );
  const scheduled: string[] = [];
  const coordinator = createConfigurationSyncCoordinator({
    repository: {
      async applySyncChange() {
        return { kind: "pending" as const, configuration, revisionId: "pending" };
      },
      async markControllerRevisionApplied() {}
    },
    callbacks: {
      async replaceConfiguration() {},
      async refreshMenus() {},
      async refreshAlarms() {},
      async refreshViews() {},
      async scheduleRetry() { scheduled.push(CONFIGURATION_SYNC_RETRY_ALARM); }
    }
  });

  await coordinator.applySyncChange(["config:v1:head"]);

  expect(scheduled).toEqual([CONFIGURATION_SYNC_RETRY_ALARM]);
});

it("buffers Sync and retry-alarm intake until asynchronous initialization is ready", () => {
  const changedListeners: Array<(changes: Record<string, unknown>, areaName: string) => void> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const dispatched: readonly string[][] = [] as unknown as readonly string[][];
  const calls = dispatched as string[][];
  const intake = registerConfigurationSyncIntake({
    storageOnChanged: { addListener(listener) { changedListeners.push(listener); } },
    alarmsOnAlarm: { addListener(listener) { alarmListeners.push(listener); } },
    dispatch(keys) { calls.push([...keys]); }
  });

  changedListeners[0]!({ "config:v1:head": {} }, "sync");
  alarmListeners[0]!({ name: CONFIGURATION_SYNC_RETRY_ALARM });

  expect(calls).toEqual([]);
  expect(intake.markReady()).toEqual({
    pending: true,
    changedKeys: ["config:v1:head"]
  });
  changedListeners[0]!({ "config:v1:revision:remote:0": {} }, "sync");
  alarmListeners[0]!({ name: "unrelated" });

  expect(calls).toEqual([["config:v1:revision:remote:0"]]);
});
