import type { Configuration } from "../domain/types";
import type {
  FixtureCommandRecord,
  ManagerDeepLink,
  ManagerRoute,
  ManagerTransport,
  ManagerViewFixture
} from "../ui/manager/types";

export type WorkbenchMode = "fixture" | "real";

export type FixtureFailurePolicy =
  | { mode: "none" }
  | {
      mode: "query" | "command" | "validation" | "offline";
      scope: "once" | "persistent";
    };

export interface WorkbenchUrlState {
  workbench: true;
  mode: WorkbenchMode;
  route: ManagerRoute;
  scenarioId: string;
  deepLink: ManagerDeepLink;
  latencyMs: number;
  failure: FixtureFailurePolicy;
}

export interface FixtureManagerControls {
  releasePending(): Promise<{
    released: Array<{
      requestId: string;
      finalState: "resolved" | "rejected";
    }>;
  }>;
  reset(): Promise<void>;
  setLatency(milliseconds: number): void;
  setFailure(policy: FixtureFailurePolicy): void;
  commandLog(): readonly FixtureCommandRecord[];
}

export interface FixtureManagerTransport {
  transport: ManagerTransport;
  controls: FixtureManagerControls;
}

export interface ScenarioDefinition {
  id: string;
  route: ManagerRoute;
  deepLink: ManagerDeepLink;
  latencyMs: number;
  failure: FixtureFailurePolicy;
  createSeed(): {
    configuration: Configuration;
    viewFixture: ManagerViewFixture;
  };
  expected: {
    heading: string;
    status: "ready" | "loading" | "error";
    description: string;
  };
}
