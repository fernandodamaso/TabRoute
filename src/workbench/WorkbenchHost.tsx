import { useEffect, useLayoutEffect, useMemo, useState } from "react";
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
import type {
  FixtureFailurePolicy,
  FixtureManagerControls,
  WorkbenchUrlState
} from "./types";
import type { ManagerTransportRecord } from "../ui/manager/types";

const WORKBENCH_CSS = `.workbench-host{display:grid;gap:12px;width:800px;min-height:100%;padding:16px;box-sizing:border-box;overflow:auto;background:#eeeae4}.workbench-controls{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:8px;padding:12px;border:1px solid #dedbd5;border-radius:10px;background:#fbfaf8}.workbench-controls label{display:grid;gap:4px;color:#625d58;font-size:10px}.workbench-controls input,.workbench-controls select{min-height:28px;box-sizing:border-box;padding:4px 6px;border:1px solid #cfc9c1;border-radius:5px;background:#fff;color:#25242a;font:inherit;font-size:11px}.workbench-controls button{min-height:28px;align-self:end;border:1px solid #9b5e3b;border-radius:5px;background:#9b5e3b;color:#fff;font:inherit;font-size:11px;cursor:pointer}.workbench-controls output{align-self:end;color:#76716b;font-size:10px}.workbench-preview{width:520px;height:600px;min-width:520px;min-height:600px;overflow:hidden;box-shadow:0 4px 18px #4f403522}.workbench-command-log{width:520px;box-sizing:border-box;padding:8px 12px;border:1px solid #dedbd5;border-radius:8px;background:#fbfaf8;color:#625d58;font-size:11px}.workbench-command-log pre{max-height:240px;overflow:auto;white-space:pre-wrap}`;

export interface WorkbenchHostProps {
  state: WorkbenchUrlState;
  fixture?: {
    transport: import("./types").FixtureManagerTransport["transport"];
    controls: FixtureManagerControls;
  };
  real: import("../ui/manager/types").ManagerTransport;
  records: readonly ManagerTransportRecord[];
  children: React.ReactNode;
  onStateChange(next: WorkbenchUrlState): void;
  onFixtureReset?: () => void;
}

function requestStatus(
  mode: WorkbenchUrlState["mode"],
  records: readonly ManagerTransportRecord[]
): WorkbenchManagerStatus {
  const query = records
    .filter(
      (
        record
      ): record is Extract<
        ManagerTransportRecord,
        { recordType: "request" }
      > => {
        if (record.recordType !== "request") return false;
        return record.mode === mode && record.message.kind === "manager-query";
      }
    )
    .at(-1);
  if (!query || query.state === "pending") return "manager-pending";
  if (query.state === "rejected") return "manager-error";
  return query.response.ok ? "manager-ready" : "manager-error";
}

function deepLinkValue(state: WorkbenchUrlState): string {
  if (typeof state.deepLink === "string") return state.deepLink;
  return state.deepLink.kind;
}

function failureModeValue(
  state: WorkbenchUrlState
): FixtureFailurePolicy["mode"] {
  return state.failure.mode;
}

export function WorkbenchHost({
  state,
  fixture,
  real: _real,
  records,
  children,
  onStateChange,
  onFixtureReset
}: WorkbenchHostProps) {
  const status = requestStatus(state.mode, records);
  const payload = useMemo(
    () => createWorkbenchMarkerPayload(state, status),
    [state, status]
  );
  const fixtureMode = state.mode === "fixture" && fixture !== undefined;
  const [deepLinkDraft, setDeepLinkDraft] = useState(() =>
    typeof state.deepLink === "object" ? state.deepLink.ruleId : ""
  );

  useEffect(() => {
    setDeepLinkDraft(
      typeof state.deepLink === "object" ? state.deepLink.ruleId : ""
    );
  }, [state.deepLink]);

  useLayoutEffect(() => {
    const elements = [
      document.documentElement,
      document.body,
      document.getElementById("root")
    ].filter((element): element is HTMLElement => element !== null);
    const previous = elements.map((element) => ({
      element,
      width: element.style.width,
      minWidth: element.style.minWidth,
      height: element.style.height,
      minHeight: element.style.minHeight,
      overflow: element.style.overflow
    }));
    for (const element of elements) {
      element.style.width = "auto";
      element.style.minWidth = "0";
      element.style.height = "auto";
      element.style.minHeight = "0";
      element.style.overflow = "auto";
    }
    return () => {
      for (const item of previous) {
        item.element.style.width = item.width;
        item.element.style.minWidth = item.minWidth;
        item.element.style.height = item.height;
        item.element.style.minHeight = item.minHeight;
        item.element.style.overflow = item.overflow;
      }
    };
  }, []);

  function change(next: WorkbenchUrlState): void {
    try {
      const search = serializeWorkbenchUrl(next);
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${search}${window.location.hash}`
      );
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
      update({
        mode,
        scenarioId: "wb:default",
        latencyMs: 0,
        failure: { mode: "none" }
      });
      return;
    }
    update({ mode });
  }

  function changeDeepLink(value: string): void {
    if (value === "edit-rule" || value === "confirm-delete") {
      const currentId =
        typeof state.deepLink === "object"
          ? state.deepLink.ruleId
          : ("00000000-0000-4000-8000-000000000101" as UUID);
      update({ deepLink: { kind: value, ruleId: currentId } });
      return;
    }
    if (value === "snapshots" || value === "diagnostics") {
      update({ route: "settings", deepLink: value });
      return;
    }
    update({ deepLink: value as WorkbenchUrlState["deepLink"] });
  }

  function commitDeepLinkDraft(): void {
    if (typeof state.deepLink !== "object") return;
    change({
      ...state,
      deepLink: { ...state.deepLink, ruleId: deepLinkDraft as UUID }
    });
  }

  function changeFailureMode(mode: FixtureFailurePolicy["mode"]): void {
    update({
      failure:
        mode === "none"
          ? { mode: "none" }
          : {
              mode,
              scope:
                state.failure.mode === "none"
                  ? "persistent"
                  : state.failure.scope
            }
    });
  }

  function changeFailureScope(scope: "once" | "persistent"): void {
    if (state.failure.mode === "none") return;
    const failure: FixtureFailurePolicy = { mode: state.failure.mode, scope };
    fixture?.controls.setFailure(failure);
    update({ failure });
  }

  return (
    <div
      className="workbench-host"
      data-workbench-marker={WORKBENCH_MARKER}
      data-workbench-status={status}
      data-workbench-registry={FIXTURE_REGISTRY_MARKER}
      data-workbench-payload={JSON.stringify(payload)}
    >
      <style data-workbench-style>{WORKBENCH_CSS}</style>
      <section className="workbench-controls" aria-label="Workbench controls">
        <label>
          Mode
          <select
            aria-label="Mode"
            {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "mode" }}
            value={state.mode}
            onChange={(event) =>
              changeMode(event.target.value as WorkbenchUrlState["mode"])
            }
          >
            <option value="fixture">Fixture</option>
            <option value="real">Real</option>
          </select>
        </label>
        <label>
          Scenario
          <select
            aria-label="Scenario"
            {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "scenario" }}
            value={state.scenarioId}
            onChange={(event) => changeScenario(event.target.value)}
          >
            {SCENARIO_DEFINITIONS.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Route
          <select
            aria-label="Route"
            {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "route" }}
            value={state.route}
            onChange={(event) =>
              update({
                route: event.target.value as WorkbenchUrlState["route"]
              })
            }
          >
            <option value="groups">Groups</option>
            <option value="rules">Rules</option>
            <option value="activity">Activity</option>
            <option value="settings">Settings</option>
          </select>
        </label>
        <label>
          Deep link
          <select
            aria-label="Deep link"
            {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "deep-link" }}
            value={deepLinkValue(state)}
            onChange={(event) => changeDeepLink(event.target.value)}
          >
            <option value="none">None</option>
            <option value="new-rule">New rule</option>
            <option value="edit-rule">Edit rule</option>
            <option value="confirm-delete">Confirm delete</option>
            <option value="snapshots">Snapshots</option>
            <option value="diagnostics">Diagnostics</option>
          </select>
        </label>
        {typeof state.deepLink === "object" && (
          <label>
            Deep-link UUID
            <input
              aria-label="Deep-link UUID"
              {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "deep-link-uuid" }}
              value={deepLinkDraft}
              onChange={(event) => setDeepLinkDraft(event.target.value)}
              onBlur={commitDeepLinkDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitDeepLinkDraft();
              }}
            />
          </label>
        )}
        {fixtureMode && (
          <>
            <label>
              Latency (ms)
              <input
                type="number"
                min="0"
                max="5000"
                aria-label="Latency"
                {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "latency" }}
                value={state.latencyMs}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 0 && value <= 5000) {
                    fixture.controls.setLatency(value);
                    update({ latencyMs: value });
                  }
                }}
              />
            </label>
            <label>
              Failure mode
              <select
                aria-label="Failure mode"
                {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "failure-mode" }}
                value={failureModeValue(state)}
                onChange={(event) => {
                  const value = event.target
                    .value as FixtureFailurePolicy["mode"];
                  fixture.controls.setFailure(
                    value === "none"
                      ? { mode: "none" }
                      : {
                          mode: value,
                          scope:
                            state.failure.mode === "none"
                              ? "persistent"
                              : state.failure.scope
                        }
                  );
                  changeFailureMode(value);
                }}
              >
                <option value="none">None</option>
                <option value="query">Query</option>
                <option value="command">Command</option>
                <option value="validation">Validation</option>
                <option value="offline">Offline</option>
              </select>
            </label>
            <label>
              Failure scope
              <select
                aria-label="Failure scope"
                {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "failure-scope" }}
                value={
                  state.failure.mode === "none"
                    ? "persistent"
                    : state.failure.scope
                }
                onChange={(event) =>
                  changeFailureScope(
                    event.target.value as "once" | "persistent"
                  )
                }
              >
                <option value="persistent">Persistent</option>
                <option value="once">Once</option>
              </select>
            </label>
            <button
              type="button"
              {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "release-pending" }}
              onClick={() => void fixture.controls.releasePending()}
            >
              Release pending response
            </button>
          </>
        )}
        <button
          type="button"
          {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "reset" }}
          onClick={() => {
            if (fixtureMode)
              void fixture.controls.reset().then(() => {
                onStateChange({ ...state });
                onFixtureReset?.();
              });
            else onStateChange({ ...state });
          }}
        >
          Reset
        </button>
        <output
          aria-label="Command log"
          {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "command-log" }}
        >
          {records.length} records
        </output>
        <output
          aria-label="Screenshot status"
          {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "screenshot-status" }}
        >
          Screenshot: not captured
        </output>
        <output
          aria-label="Result status"
          {...{ [WORKBENCH_CONTROL_ATTRIBUTE]: "result-status" }}
        >
          Result:{" "}
          {status === "manager-ready"
            ? "ready"
            : status === "manager-error"
              ? "error"
              : "pending"}
        </output>
      </section>
      <div
        className="workbench-preview"
        data-testid="workbench-preview"
        data-preview-width="520"
        data-preview-height="600"
        style={{ width: "520px", height: "600px" }}
      >
        {children}
      </div>
      <details className="workbench-command-log">
        <summary>Command log ({records.length})</summary>
        <pre>{JSON.stringify(records, null, 2)}</pre>
      </details>
    </div>
  );
}
