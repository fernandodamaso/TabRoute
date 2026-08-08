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
