import type { UUID } from "../domain/types";
import type { ManagerDeepLink, ManagerRoute } from "../ui/manager/types";
import { SCENARIO_IDS } from "./scenarios";
import type { FixtureFailurePolicy, WorkbenchUrlState } from "./types";

const KEYS = [
  "workbench",
  "mode",
  "route",
  "scenario",
  "deep-link",
  "latency",
  "failure"
] as const;

const ROUTES: readonly ManagerRoute[] = ["groups", "rules", "activity", "settings"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  throw new Error(`Invalid workbench URL: ${message}`);
}

function parseDeepLink(value: string): ManagerDeepLink {
  if (value === "none" || value === "new-rule" || value === "snapshots" || value === "diagnostics") {
    return value;
  }
  const match = /^(edit-rule|confirm-delete):(.+)$/.exec(value);
  if (!match) return fail("invalid deep-link");
  const ruleId = match[2]!;
  if (!UUID_PATTERN.test(ruleId)) return fail("deep-link rule id must be a UUID");
  return {
    kind: match[1] as "edit-rule" | "confirm-delete",
    ruleId: ruleId as UUID
  };
}

function serializeDeepLink(value: ManagerDeepLink): string {
  return typeof value === "string" ? value : `${value.kind}:${value.ruleId}`;
}

function parseFailure(value: string): FixtureFailurePolicy {
  if (value === "none") return { mode: "none" };
  const parts = value.split(":");
  if (parts.length > 2) return fail("invalid failure syntax");
  const [mode, rawScope] = parts;
  if (mode !== "query" && mode !== "command" && mode !== "validation" && mode !== "offline")
    return fail("invalid failure mode");
  const scope = rawScope ?? "persistent";
  if (scope !== "once" && scope !== "persistent") return fail("invalid failure scope");
  return { mode, scope };
}

function serializeFailure(value: FixtureFailurePolicy): string {
  if (value.mode === "none") return "none";
  return value.scope === "persistent" ? value.mode : `${value.mode}:${value.scope}`;
}

function validateState(state: WorkbenchUrlState): WorkbenchUrlState {
  if (state.workbench !== true) return fail("workbench must be enabled");
  if (state.mode !== "fixture" && state.mode !== "real") return fail("invalid mode");
  if (!ROUTES.includes(state.route)) return fail("invalid route");
  if (!SCENARIO_IDS.includes(state.scenarioId as (typeof SCENARIO_IDS)[number]))
    return fail("invalid scenario");
  if (typeof state.deepLink === "object" && !UUID_PATTERN.test(state.deepLink.ruleId))
    return fail("deep-link rule id must be a UUID");
  if (!Number.isInteger(state.latencyMs) || state.latencyMs < 0 || state.latencyMs > 5000)
    return fail("latency must be an integer from 0 through 5000");
  if (state.failure.mode !== "none") {
    if (!(["query", "command", "validation", "offline"] as const).includes(state.failure.mode))
      return fail("invalid failure mode");
    if (state.failure.scope !== "once" && state.failure.scope !== "persistent")
      return fail("invalid failure scope");
  }
  if (state.mode === "real") {
    if (state.scenarioId !== "wb:default") return fail("real mode accepts only wb:default");
    if (state.latencyMs !== 0) return fail("real mode latency must be zero");
    if (state.failure.mode !== "none") return fail("real mode failure must be none");
  }
  return state;
}

export function parseWorkbenchSearch(search: string): WorkbenchUrlState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!KEYS.includes(key as (typeof KEYS)[number])) fail(`unknown parameter: ${key}`);
    if (seen.has(key)) fail(`duplicate parameter: ${key}`);
    seen.add(key);
  }
  for (const key of KEYS) {
    if (!seen.has(key)) fail(`missing parameter: ${key}`);
  }

  if (params.get("workbench") !== "1") fail("workbench must equal 1");
  const mode = params.get("mode");
  if (mode !== "fixture" && mode !== "real") fail("invalid mode");
  const route = params.get("route");
  if (!ROUTES.includes(route as ManagerRoute)) fail("invalid route");
  const scenarioId = params.get("scenario")!;
  if (!SCENARIO_IDS.includes(scenarioId as (typeof SCENARIO_IDS)[number])) fail("invalid scenario");
  const latencyText = params.get("latency")!;
  if (!/^\d+$/.test(latencyText)) fail("latency must be an integer");
  const latencyMs = Number(latencyText);
  const state: WorkbenchUrlState = {
    workbench: true,
    mode,
    route: route as ManagerRoute,
    scenarioId,
    deepLink: parseDeepLink(params.get("deep-link")!),
    latencyMs,
    failure: parseFailure(params.get("failure")!)
  };
  return validateState(state);
}

export function serializeWorkbenchUrl(state: WorkbenchUrlState): string {
  const valid = validateState(state);
  const values = [
    ["workbench", "1"],
    ["mode", valid.mode],
    ["route", valid.route],
    ["scenario", valid.scenarioId],
    ["deep-link", serializeDeepLink(valid.deepLink)],
    ["latency", String(valid.latencyMs)],
    ["failure", serializeFailure(valid.failure)]
  ] as const;
  return `?${values.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}
