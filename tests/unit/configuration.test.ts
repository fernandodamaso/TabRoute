import { createDefaultConfiguration, renameGroup } from "../../src/domain/defaults";
import { validateConfiguration } from "../../src/domain/schemas";

it("creates one UUID-backed fallback group whose role survives a rename", () => {
  const configuration = createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001");
  const fallback = configuration.groups.find((group) => group.id === configuration.fallbackGroupId);

  expect(configuration.groups).toHaveLength(1);
  expect(fallback?.isFallback).toBe(true);
  expect(fallback?.id).toBe(configuration.fallbackGroupId);
  const renamed = renameGroup(configuration, configuration.fallbackGroupId, "Later");
  expect(renamed.groups[0]?.isFallback).toBe(true);
  expect(renamed.groups[0]?.id).toBe(configuration.fallbackGroupId);
  expect(validateConfiguration(configuration)).toEqual(configuration);
});

it("accepts integer pause timestamps and rejects invalid numeric pause values", () => {
  const configuration = createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001");
  const timed = { ...configuration, globalPausedUntil: 2000000000000 };
  expect(validateConfiguration(timed).globalPausedUntil).toBe(2000000000000);
  expect(() => validateConfiguration({ ...configuration, globalPausedUntil: 1.5 })).toThrow();
  expect(() => validateConfiguration({ ...configuration, globalPausedUntil: -1 })).toThrow();
});
