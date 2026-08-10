import { createConfigurationRepository } from "../../src/state/configurationRepository";
import { createDefaultConfiguration } from "../../src/domain/defaults";

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
