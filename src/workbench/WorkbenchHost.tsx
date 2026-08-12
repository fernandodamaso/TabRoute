import { useMemo } from "react";
import type { UUID } from "../domain/types";
import { SCENARIO_DEFINITIONS, getScenarioDefaultUrlState } from "./scenarios";
import {
  FIXTURE_REGISTRY_MARKER,
  WORKBENCH_CONTROL_ATTRIBUTE,
  WORKBENCH_MARKER,
  createWorkbenchMarkerPayload,
  type WorkbenchManagerStatus
} from "./markers";
import { serializeWorkbenchUrl } from "./url";
import type { FixtureFailurePolicy, FixtureManagerControls, WorkbenchUrlState } from "./types";
import type { ManagerTransportRecord } from "../ui/manager/types";

export interface WorkbenchHostProps {
  state: WorkbenchUrlState;
  fixture?: { transport: import("./types").FixtureManagerTransport["transport"]; controls: FixtureManagerControls };
  real: import("../ui/manager/types").ManagerTransport;
  records: readonly ManagerTransportRecord[];
  children: React.ReactNode;
  onStateChange(next: WorkbenchUrlState): void;
}

function requestStatus(
  mode: WorkbenchUrlState["mode"],
  records: readonly ManagerTransportRecord[]
): WorkbenchManagerStatus {
  const query = records.find((record): record is Extract<ManagerTransportRecord, { recordType: "request" }> => {
    if (record.recordType !== "request") return false;
    return record.mode === mode && record.message.kind === "manager-query";
  });
  if (!query || query.state === "pending") return "manager-pending";
  return query.state === "resolved" ? "manager-ready" : "manager-error";
}

function deepLinkValue(state: WorkbenchUrlState): string {
  if (typeof state.deepLink === "string") return state.deepLink;
  return state.deepLink.kind;
}

function failureModeValue(state: WorkbenchUrlState): FixtureFailurePolicy["mode"] {
  return state.failure.mode;
}

export function WorkbenchHost({ state, fixture, real: _real, records, children, onStateChange }: WorkbenchHostProps) {
  const status = requestStatus(state.mode, records);
  const payload = useMemo(() => createWorkbenchMarkerPayload(state, status), [state, status]);
  const fixtureMode = state.mode === "fixture" && fixture !== undefined;

  function change(next: WorkbenchUrlState): void {
    try {
      const search = serializeWorkbenchUrl(next);
      window.history.replaceState({}, "", `${window.location.pathname}${search}${window.location.hash}`);
      onStateChange(next);
    } catch {
      // URL validation is the boundary for all workbench control updates.
    }
  }

  function update(patch: Partial<WorkbenchUrlState>): void {
    change({ ...state, ...patch });
  }

  function changeScenario(scenarioId: string): void {
    const next = getScenarioDefaultUrlState(scenarioId);
    change({ ...next, mode: state.mode === "real" ? "real" : "fixture" });
  }

  function changeMode(mode: WorkbenchUrlState["mode"]): void {
    if (mode === "real") {
      update({ mode, scenarioId: "wb:default", latencyMs: 0, failure: { mode: "none" } });
      return;
    }
    update({ mode });
  }

  function changeDeepLink(value: string): void {
    if (value === "edit-rule" || value === "confirm-delete") {
      const currentId = typeof state.deepLink === "object"
        ? state.deepLink.ruleId
        : "00000000-0000-4000-8000-000000000101" as UUID;
      update({ deepLink: { kind: value, ruleId: currentId } });
      return;
    }
    update({ deepLink: value as WorkbenchUrlState["deepLink"] });
  }

  function changeFailureMode(mode: FixtureFailurePolicy["mode"]): void {
    update({ failure: mode === "none" ? { mode: "none" } : { mode, scope: state.failure.mode === "none" ? "persistent" : state.failure.scope } });
  }

  function changeFailureScope(scope: "once" | "persistent"): void {
    if (state.failure.mode === "none") return;
    const failure: FixtureFailurePolicy = { mode: state.failure.mode, scope };
    fixture?.controls.setFailure(failure);
    update({ failure });
  }

  return <div
    className="workbench-host"
    data-workbench-marker={WORKBENCH_MARKER}
    data-workbench-status={status}
    data-workbench-registry={FIXTURE_REGISTRY_MARKER}
    data-workbench-payload={JSON.stringify(payload)}
  >
    <section className="workbench-controls" aria-label="Workbench controls">
      <label>Mode<select aria-label="Mode" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "mode" }} value={state.mode} onChange={(event) => changeMode(event.target.value as WorkbenchUrlState["mode"])}><option value="fixture">Fixture</option><option value="real">Real</option></select></label>
      <label>Scenario<select aria-label="Scenario" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "scenario" }} value={state.scenarioId} onChange={(event) => changeScenario(event.target.value)}>{SCENARIO_DEFINITIONS.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.id}</option>)}</select></label>
      <label>Route<select aria-label="Route" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "route" }} value={state.route} onChange={(event) => update({ route: event.target.value as WorkbenchUrlState["route"] })}><option value="groups">Groups</option><option value="rules">Rules</option><option value="activity">Activity</option><option value="settings">Settings</option></select></label>
      <label>Deep link<select aria-label="Deep link" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "deep-link" }} value={deepLinkValue(state)} onChange={(event) => changeDeepLink(event.target.value)}><option value="none">None</option><option value="new-rule">New rule</option><option value="edit-rule">Edit rule</option><option value="confirm-delete">Confirm delete</option></select></label>
      {typeof state.deepLink === "object" && (() => { const deepLink = state.deepLink; return <label>Deep-link UUID<input aria-label="Deep-link UUID" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "deep-link-uuid" }} value={deepLink.ruleId} onChange={(event) => update({ deepLink: { ...deepLink, ruleId: event.target.value as UUID } })} /></label>; })()}
      {fixtureMode && <>
        <label>Latency (ms)<input type="number" min="0" max="5000" aria-label="Latency" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "latency" }} value={state.latencyMs} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 0 && value <= 5000) { fixture.controls.setLatency(value); update({ latencyMs: value }); } }} /></label>
        <label>Failure mode<select aria-label="Failure mode" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "failure-mode" }} value={failureModeValue(state)} onChange={(event) => { const value = event.target.value as FixtureFailurePolicy["mode"]; fixture.controls.setFailure(value === "none" ? { mode: "none" } : { mode: value, scope: state.failure.mode === "none" ? "persistent" : state.failure.scope }); changeFailureMode(value); }}><option value="none">None</option><option value="query">Query</option><option value="command">Command</option><option value="validation">Validation</option><option value="offline">Offline</option></select></label>
        <label>Failure scope<select aria-label="Failure scope" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "failure-scope" }} value={state.failure.mode === "none" ? "persistent" : state.failure.scope} onChange={(event) => changeFailureScope(event.target.value as "once" | "persistent")}><option value="persistent">Persistent</option><option value="once">Once</option></select></label>
        <button type="button" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "release-pending" }} onClick={() => void fixture.controls.releasePending()}>Release pending response</button>
      </>}
      <button type="button" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "reset" }} onClick={() => { if (fixtureMode) void fixture.controls.reset().then(() => onStateChange({ ...state })); else onStateChange({ ...state }); }}>Reset</button>
      <output aria-label="Command log" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "command-log" }}>{records.length} records</output>
      <output aria-label="Screenshot status" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "screenshot-status" }}>Screenshot: not captured</output>
      <output aria-label="Result status" {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "result-status" }}>Result: {status === "manager-ready" ? "ready" : status === "manager-error" ? "error" : "pending"}</output>
    </section>
    <div className="workbench-preview" data-testid="workbench-preview" data-preview-width="520" data-preview-height="600" style={{ width: "520px", height: "600px" }}>{children}</div>
    <details className="workbench-command-log"><summary>Command log ({records.length})</summary><pre>{JSON.stringify(records, null, 2)}</pre></details>
  </div>;
}
