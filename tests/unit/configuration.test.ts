import {
  createDefaultConfiguration,
  renameGroup,
  updateManagedGroup
} from "../../src/domain/defaults";
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
  expect(fallback?.enabled).toBe(true);
});

it("updates group enablement without changing identity and keeps fallback enabled", () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const withGroup = {
    ...configuration,
    groups: [
      ...configuration.groups,
      {
        ...configuration.groups[0]!,
        id: "00000000-0000-4000-8000-000000000002" as typeof configuration.fallbackGroupId,
        name: "Work",
        isFallback: false,
        defaultOrder: 1
      }
    ]
  };
  const updated = updateManagedGroup(
    withGroup,
    withGroup.groups[1]!.id,
    { enabled: false }
  );
  expect(updated.groups[1]?.enabled).toBe(false);
  expect(() => updateManagedGroup(updated, updated.fallbackGroupId, { enabled: false })).toThrow(/fallback/);
  expect(updated.fallbackGroupId).toBe(configuration.fallbackGroupId);
});

it("accepts integer pause timestamps and rejects invalid numeric pause values", () => {
  const configuration = createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001");
  const timed = { ...configuration, globalPausedUntil: 2000000000000 };
  expect(validateConfiguration(timed).globalPausedUntil).toBe(2000000000000);
  expect(() => validateConfiguration({ ...configuration, globalPausedUntil: 1.5 })).toThrow();
  expect(() => validateConfiguration({ ...configuration, globalPausedUntil: -1 })).toThrow();
});
