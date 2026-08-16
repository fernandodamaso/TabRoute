import {
  createManagerMessageRouter,
  createFixtureActivityManagerPort,
  createFixtureDiagnosticsManagerPort,
  createFixtureSnapshotManagerPort
} from "../background/managerMessageRouter";
import { validateConfiguration } from "../domain/schemas";
import type { Configuration } from "../domain/types";
import type {
  FixtureCommandRecord,
  ManagerFailure,
  ManagerMessage,
  ManagerResponse,
  ManagerSuccess
} from "../ui/manager/types";
import { getScenarioDefinition } from "./scenarios";
import type { FixtureFailurePolicy, FixtureManagerTransport } from "./types";

export const FIXTURE_CLOCK_START = 1_900_000_000_000;

type Router = ReturnType<typeof createManagerMessageRouter>;

type FixtureGeneration = {
  id: number;
  configuration: Configuration;
  viewFixture: ReturnType<
    ReturnType<typeof getScenarioDefinition>["createSeed"]
  >["viewFixture"];
  virtualClock: number;
  identifierSequence: number;
  failurePolicy: FixtureFailurePolicy;
};

type ActiveRequest = {
  generation: FixtureGeneration;
  router: Router;
  recordIndex: number;
  requestId: string;
  message: ManagerMessage;
  latencyMs: number;
  resolve: (response: ManagerResponse) => void;
};

type FixtureOptions = {
  scenarioId: string;
  latencyMs?: number;
  failure?: FixtureFailurePolicy;
};

type Settlement = {
  response: ManagerResponse;
  finalState: "resolved" | "rejected";
};

function failure(
  kind: ManagerFailure["error"]["kind"],
  code: string,
  message: string
): ManagerFailure {
  return { ok: false, error: { kind, code, message } };
}

function assertLatency(milliseconds: number): void {
  if (
    !Number.isInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 5000
  )
    throw new Error("Fixture latency must be an integer from 0 through 5000");
}

function cloneFailure(policy: FixtureFailurePolicy): FixtureFailurePolicy {
  return policy.mode === "none" ? { mode: "none" } : { ...policy };
}

function runtimeUuid(sequence: number): string {
  return `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

export function createFixtureManagerTransport(
  input: FixtureOptions
): FixtureManagerTransport {
  const scenario = getScenarioDefinition(input.scenarioId);
  const initialLatency = input.latencyMs ?? scenario.latencyMs;
  const initialFailure = cloneFailure(input.failure ?? scenario.failure);
  assertLatency(initialLatency);

  let generationSequence = 0;
  let generation: FixtureGeneration;
  let router: Router;
  let latencyMs: number;
  let requestSequence: number;
  let holdPending: boolean;
  let log: FixtureCommandRecord[];
  let pending: ActiveRequest[];
  let active: Set<ActiveRequest>;
  let executionTail: Promise<void>;

  function createRouter(target: FixtureGeneration): Router {
    const activity = createFixtureActivityManagerPort({
      getViewFixture: () => target.viewFixture,
      setViewFixture: (next) => {
        target.viewFixture = next;
      }
    });
    const snapshots = createFixtureSnapshotManagerPort({
      getViewFixture: () => target.viewFixture,
      setViewFixture: (next) => {
        target.viewFixture = next;
      },
      getConfiguration: () => target.configuration
    });
    const diagnostics = createFixtureDiagnosticsManagerPort({
      getViewFixture: () => target.viewFixture,
      setViewFixture: (next) => {
        target.viewFixture = next;
      },
      getConfiguration: () => target.configuration
    });
    return createManagerMessageRouter({
      repository: {
        async save(next) {
          target.configuration = validateConfiguration(next);
        }
      },
      controller: {
        getConfiguration() {
          return target.configuration;
        },
        async replaceConfiguration(next) {
          target.configuration = validateConfiguration(next);
        }
      },
      activity,
      snapshots,
      diagnostics,
      randomUuid: () => {
        target.identifierSequence += 1;
        return runtimeUuid(target.identifierSequence);
      },
      now: () => target.virtualClock
    });
  }

  function initialize(): void {
    const seed = scenario.createSeed();
    generationSequence += 1;
    generation = {
      id: generationSequence,
      configuration: validateConfiguration(seed.configuration),
      viewFixture: seed.viewFixture,
      virtualClock: FIXTURE_CLOCK_START,
      identifierSequence: 0,
      failurePolicy: cloneFailure(initialFailure)
    };
    router = createRouter(generation);
    latencyMs = initialLatency;
    requestSequence = 0;
    holdPending = scenario.id === "wb:loading";
    log = [];
    pending = [];
    active = new Set();
    executionTail = Promise.resolve();
  }

  function matchingFailure(
    target: FixtureGeneration,
    message: ManagerMessage
  ): ManagerFailure | undefined {
    const policy = target.failurePolicy;
    if (policy.mode === "none") return undefined;

    let result: ManagerFailure | undefined;
    if (policy.mode === "offline") {
      result = failure("offline", "OFFLINE", "Fixture transport is offline");
    } else if (policy.mode === "query" && message.kind === "manager-query") {
      result = failure(
        "transport",
        "FIXTURE_QUERY_FAILURE",
        "Fixture query failure"
      );
    } else if (
      policy.mode === "command" &&
      message.kind === "manager-command"
    ) {
      result = failure(
        "transport",
        "FIXTURE_COMMAND_FAILURE",
        "Fixture command failure"
      );
    } else if (
      policy.mode === "validation" &&
      message.kind === "manager-command"
    ) {
      result = failure(
        "validation",
        "FIXTURE_VALIDATION_FAILURE",
        "Fixture validation failure"
      );
    }

    if (result && policy.scope === "once")
      target.failurePolicy = { mode: "none" };
    return result;
  }

  async function wait(milliseconds: number): Promise<void> {
    if (milliseconds === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  function isCurrent(entry: ActiveRequest): boolean {
    return entry.generation.id === generation.id && active.has(entry);
  }

  async function settle(entry: ActiveRequest): Promise<Settlement | undefined> {
    if (!isCurrent(entry)) return undefined;
    const current = log[entry.recordIndex];
    if (!current || current.state !== "pending") return undefined;

    const executionStartedAt = Math.max(
      entry.generation.virtualClock,
      current.startedAt
    );
    await wait(entry.latencyMs);
    if (!isCurrent(entry)) return undefined;

    const endedAt = executionStartedAt + entry.latencyMs;
    entry.generation.virtualClock = endedAt;
    const injected = matchingFailure(entry.generation, entry.message);
    const raw = injected ?? (await entry.router.handle(entry.message));
    if (!isCurrent(entry)) return undefined;

    const response: ManagerResponse = raw.ok
      ? ({
          ...raw,
          viewFixture: entry.generation.viewFixture
        } satisfies ManagerSuccess)
      : raw;

    if (response.ok) {
      log[entry.recordIndex] = {
        ...current,
        state: "resolved",
        endedAt,
        response
      };
      active.delete(entry);
      entry.resolve(response);
      return { response, finalState: "resolved" };
    }

    log[entry.recordIndex] = {
      ...current,
      state: "rejected",
      endedAt,
      error: response.error
    };
    active.delete(entry);
    entry.resolve(response);
    return { response, finalState: "rejected" };
  }

  function enqueue(entry: ActiveRequest): Promise<Settlement | undefined> {
    const queued = executionTail.then(
      () => settle(entry),
      () => settle(entry)
    );
    executionTail = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  initialize();

  const transport: FixtureManagerTransport["transport"] = {
    allowPreview: true,
    request(message) {
      requestSequence += 1;
      const sequence = requestSequence;
      const requestId = `manager-fixture-${sequence}`;
      const requestLatency = latencyMs;
      const recordIndex = log.length;
      log.push({
        recordType: "request",
        state: "pending",
        mode: "fixture",
        requestId,
        sequence,
        scenarioId: scenario.id,
        message,
        startedAt: generation.virtualClock,
        latencyMs: requestLatency
      });

      return new Promise<ManagerResponse>((resolve) => {
        const entry: ActiveRequest = {
          generation,
          router,
          recordIndex,
          requestId,
          message,
          latencyMs: requestLatency,
          resolve
        };
        active.add(entry);
        if (holdPending) {
          pending.push(entry);
          return;
        }
        void enqueue(entry);
      });
    }
  };

  const controls: FixtureManagerTransport["controls"] = {
    async releasePending() {
      const released: Array<{
        requestId: string;
        finalState: "resolved" | "rejected";
      }> = [];
      const releasing = pending;
      pending = [];
      holdPending = false;

      const results = await Promise.all(
        releasing.map((entry) => enqueue(entry))
      );
      for (const [index, result] of results.entries()) {
        if (!result) continue;
        const entry = releasing[index]!;
        released.push({
          requestId: entry.requestId,
          finalState: result.finalState
        });
      }
      return { released };
    },

    async reset() {
      const resetResponse = failure(
        "transport",
        "FIXTURE_RESET",
        "Fixture request was cleared by reset"
      );
      for (const entry of active) entry.resolve(resetResponse);
      active.clear();
      initialize();
    },

    setLatency(milliseconds) {
      assertLatency(milliseconds);
      latencyMs = milliseconds;
    },

    setFailure(policy) {
      generation.failurePolicy = cloneFailure(policy);
    },

    commandLog() {
      return log;
    }
  };

  return { transport, controls };
}
