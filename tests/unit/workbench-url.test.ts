import {
  SCENARIO_DEFINITIONS,
  SCENARIO_IDS,
  getScenarioDefinition
} from "../../src/workbench/scenarios";
import { parseWorkbenchSearch, serializeWorkbenchUrl } from "../../src/workbench/url";

const canonicalDefault =
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none";

it("parses and serializes the canonical workbench URL in exact key order", () => {
  const state = parseWorkbenchSearch(canonicalDefault);

  expect(state).toEqual({
    workbench: true,
    mode: "fixture",
    route: "groups",
    scenarioId: "wb:default",
    deepLink: "none",
    latencyMs: 0,
    failure: { mode: "none" }
  });
  expect(serializeWorkbenchUrl(state)).toBe(canonicalDefault);
});

it("canonicalizes encoded deep links and persistent failure scope", () => {
  const ruleId = "00000000-0000-4000-8000-000000000101";
  const state = parseWorkbenchSearch(
    `?workbench=1&mode=fixture&route=rules&scenario=wb%3Aedit-rule&deep-link=edit-rule%3A${ruleId}&latency=0050&failure=query%3Apersistent`
  );

  expect(state.deepLink).toEqual({ kind: "edit-rule", ruleId });
  expect(state.latencyMs).toBe(50);
  expect(state.failure).toEqual({ mode: "query", scope: "persistent" });
  expect(serializeWorkbenchUrl(state)).toBe(
    `?workbench=1&mode=fixture&route=rules&scenario=wb%3Aedit-rule&deep-link=edit-rule%3A${ruleId}&latency=50&failure=query`
  );
});

it("accepts every approved route and fixture scenario", () => {
  expect(SCENARIO_IDS).toHaveLength(15);
  for (const definition of SCENARIO_DEFINITIONS) {
    const deepLink = definition.deepLink === "none" || definition.deepLink === "new-rule"
      ? definition.deepLink
      : `${definition.deepLink.kind}:${definition.deepLink.ruleId}`;
    const state = parseWorkbenchSearch(
      `?workbench=1&mode=fixture&route=${definition.route}&scenario=${encodeURIComponent(definition.id)}&deep-link=${encodeURIComponent(deepLink)}&latency=5000&failure=command%3Aonce`
    );

    expect(state.route).toBe(definition.route);
    expect(state.scenarioId).toBe(definition.id);
    expect(state.latencyMs).toBe(5000);
    expect(state.failure).toEqual({ mode: "command", scope: "once" });
  }
});

it("serializes scenario transport defaults as explicit canonical URL parameters", () => {
  const cases = [
    {
      id: "wb:slow",
      latencyMs: 250,
      failure: { mode: "none" } as const,
      expected: "?workbench=1&mode=fixture&route=groups&scenario=wb%3Aslow&deep-link=none&latency=250&failure=none"
    },
    {
      id: "wb:validation-error",
      latencyMs: 0,
      failure: { mode: "validation", scope: "persistent" } as const,
      expected: "?workbench=1&mode=fixture&route=rules&scenario=wb%3Avalidation-error&deep-link=new-rule&latency=0&failure=validation"
    },
    {
      id: "wb:offline",
      latencyMs: 0,
      failure: { mode: "offline", scope: "persistent" } as const,
      expected: "?workbench=1&mode=fixture&route=groups&scenario=wb%3Aoffline&deep-link=none&latency=0&failure=offline"
    }
  ] as const;

  for (const scenarioCase of cases) {
    const definition = getScenarioDefinition(scenarioCase.id);
    expect(definition).toEqual(expect.objectContaining({
      latencyMs: scenarioCase.latencyMs,
      failure: scenarioCase.failure
    }));
    const url = serializeWorkbenchUrl({
      workbench: true,
      mode: "fixture",
      route: definition.route,
      scenarioId: definition.id,
      deepLink: definition.deepLink,
      latencyMs: scenarioCase.latencyMs,
      failure: scenarioCase.failure
    });
    expect(url).toBe(scenarioCase.expected);
    expect(parseWorkbenchSearch(url)).toEqual({
      workbench: true,
      mode: "fixture",
      route: definition.route,
      scenarioId: definition.id,
      deepLink: definition.deepLink,
      latencyMs: scenarioCase.latencyMs,
      failure: scenarioCase.failure
    });
  }
});

it.each([
  "?workbench=0&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none",
  "?workbench=1&mode=preview&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none",
  "?workbench=1&mode=fixture&route=snapshots&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none",
  "?workbench=1&mode=fixture&route=diagnostics&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Aactivity&deep-link=none&latency=0&failure=none",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=edit-rule%3Anot-a-uuid&latency=0&failure=none",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=unknown&latency=0&failure=none",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=-1&failure=none",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=5001&failure=none",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=1.5&failure=none",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none%3Aonce",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=query%3Atwice",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=query%3Aonce%3Aextra",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none&extra=1",
  "?workbench=1&mode=fixture&mode=real&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none",
  "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0"
])("rejects invalid or non-canonical workbench search: %s", (search) => {
  expect(() => parseWorkbenchSearch(search)).toThrow();
});

it.each([
  "?workbench=1&mode=real&route=groups&scenario=wb%3Aloading&deep-link=none&latency=0&failure=none",
  "?workbench=1&mode=real&route=groups&scenario=wb%3Adefault&deep-link=none&latency=1&failure=none",
  "?workbench=1&mode=real&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=offline"
])("rejects fixture-only controls in real mode: %s", (search) => {
  expect(() => parseWorkbenchSearch(search)).toThrow();
});
