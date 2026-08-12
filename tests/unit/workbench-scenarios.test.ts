import { validateConfiguration } from "../../src/domain/schemas";
import {
  FIXTURE_IDS,
  SCENARIO_DEFINITIONS,
  SCENARIO_IDS,
  getScenarioDefinition
} from "../../src/workbench/scenarios";

const expectedScenarioIds = [
  "wb:default",
  "wb:empty-groups",
  "wb:dense-groups",
  "wb:enabled-group",
  "wb:disabled-group",
  "wb:empty-persistent-tabs",
  "wb:populated-persistent-tabs",
  "wb:mixed-rules-overview",
  "wb:new-rule",
  "wb:edit-rule",
  "wb:confirmation-overlay",
  "wb:loading",
  "wb:slow",
  "wb:validation-error",
  "wb:offline"
] as const;

it("registers exactly the 15 approved fixture scenarios", () => {
  expect(SCENARIO_IDS).toEqual(expectedScenarioIds);
  expect(SCENARIO_DEFINITIONS.map((definition) => definition.id)).toEqual(expectedScenarioIds);
  expect(SCENARIO_IDS).not.toContain("wb:activity");
  expect(SCENARIO_IDS.some((id) => id.includes("snapshot"))).toBe(false);
  expect(SCENARIO_IDS.some((id) => id.includes("diagnostic"))).toBe(false);
});

it("creates fresh deterministic seeds accepted by the existing configuration schema", () => {
  for (const definition of SCENARIO_DEFINITIONS) {
    const first = definition.createSeed();
    const second = definition.createSeed();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.configuration).not.toBe(second.configuration);
    expect(validateConfiguration(first.configuration)).toEqual(first.configuration);
    expect(first.configuration.persistentTabs).toEqual([]);
  }
});

it("covers empty, dense, enabled, disabled, loading, error, overlay, and persistent-tab display states", () => {
  const empty = getScenarioDefinition("wb:empty-groups").createSeed();
  const dense = getScenarioDefinition("wb:dense-groups").createSeed();
  const enabled = getScenarioDefinition("wb:enabled-group").createSeed();
  const disabled = getScenarioDefinition("wb:disabled-group").createSeed();
  const persistentEmpty = getScenarioDefinition("wb:empty-persistent-tabs").createSeed();
  const persistentPopulated = getScenarioDefinition("wb:populated-persistent-tabs").createSeed();

  expect(empty.configuration.groups.filter((group) => !group.isFallback)).toHaveLength(0);
  expect(dense.configuration.groups.filter((group) => !group.isFallback).length).toBeGreaterThanOrEqual(8);
  expect(enabled.configuration.groups.find((group) => group.id === FIXTURE_IDS.primaryGroup)?.enabled).toBe(true);
  expect(disabled.configuration.groups.find((group) => group.id === FIXTURE_IDS.primaryGroup)?.enabled).toBe(false);
  expect(enabled.configuration.groups[0]?.id).toBe(FIXTURE_IDS.primaryGroup);
  expect(disabled.configuration.groups[0]?.id).toBe(FIXTURE_IDS.primaryGroup);
  expect(persistentEmpty.configuration.groups[0]?.id).toBe(FIXTURE_IDS.primaryGroup);
  expect(persistentPopulated.configuration.groups[0]?.id).toBe(FIXTURE_IDS.primaryGroup);
  expect(persistentEmpty.viewFixture.persistentTabsByGroup[FIXTURE_IDS.primaryGroup]).toEqual({
    state: "empty",
    tabs: []
  });
  expect(persistentPopulated.viewFixture.persistentTabsByGroup[FIXTURE_IDS.primaryGroup]).toEqual({
    state: "populated",
    tabs: ["Docs — https://docs.example.test/", "Inbox — https://mail.example.test/inbox"]
  });
  expect(persistentPopulated.configuration.persistentTabs).toEqual([]);

  expect(getScenarioDefinition("wb:loading").expected.status).toBe("loading");
  expect(getScenarioDefinition("wb:validation-error").expected.status).toBe("error");
  expect(getScenarioDefinition("wb:offline").expected.status).toBe("error");
  expect(getScenarioDefinition("wb:confirmation-overlay").deepLink).toEqual({
    kind: "confirm-delete",
    ruleId: FIXTURE_IDS.editRule
  });
});

it("stores scenario transport defaults with the canonical scenario data", () => {
  expect(getScenarioDefinition("wb:default")).toEqual(expect.objectContaining({
    latencyMs: 0,
    failure: { mode: "none" }
  }));
  expect(getScenarioDefinition("wb:slow")).toEqual(expect.objectContaining({
    latencyMs: 250,
    failure: { mode: "none" }
  }));
  expect(getScenarioDefinition("wb:validation-error")).toEqual(expect.objectContaining({
    latencyMs: 0,
    failure: { mode: "validation", scope: "persistent" }
  }));
  expect(getScenarioDefinition("wb:offline")).toEqual(expect.objectContaining({
    latencyMs: 0,
    failure: { mode: "offline", scope: "persistent" }
  }));
});

it("uses stable fixture rule identities for edit and confirmation scenarios", () => {
  const edit = getScenarioDefinition("wb:edit-rule");
  const confirmation = getScenarioDefinition("wb:confirmation-overlay");
  const editSeed = edit.createSeed();
  const confirmationSeed = confirmation.createSeed();

  expect(edit.deepLink).toEqual({ kind: "edit-rule", ruleId: FIXTURE_IDS.editRule });
  expect(confirmation.deepLink).toEqual({ kind: "confirm-delete", ruleId: FIXTURE_IDS.editRule });
  expect(editSeed.configuration.rules.some((rule) => rule.id === FIXTURE_IDS.editRule)).toBe(true);
  expect(confirmationSeed.configuration.rules.some((rule) => rule.id === FIXTURE_IDS.editRule)).toBe(true);
  expect(getScenarioDefinition("wb:new-rule").deepLink).toBe("new-rule");
  expect(getScenarioDefinition("wb:mixed-rules-overview").route).toBe("rules");
});
