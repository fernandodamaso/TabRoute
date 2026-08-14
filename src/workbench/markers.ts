import type { WorkbenchMode, WorkbenchUrlState } from "./types";

export const WORKBENCH_MARKER = "TABROUTE_DEV_WORKBENCH_V1";
export const WORKBENCH_CONTROL_ATTRIBUTE = "data-workbench-control";
export const FIXTURE_REGISTRY_MARKER = "tabrouteFixtureRegistryV1";

export type WorkbenchManagerStatus =
  "manager-pending" | "manager-ready" | "manager-error";

export interface WorkbenchMarkerPayload {
  mode: WorkbenchMode;
  scenario: string;
  route: WorkbenchUrlState["route"];
  transportStatus: WorkbenchManagerStatus;
}

export function createWorkbenchMarkerPayload(
  state: WorkbenchUrlState,
  transportStatus: WorkbenchManagerStatus
): WorkbenchMarkerPayload {
  return {
    mode: state.mode,
    scenario: state.scenarioId,
    route: state.route,
    transportStatus
  };
}
