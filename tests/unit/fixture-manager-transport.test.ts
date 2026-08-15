import { readFileSync } from "node:fs";
import type {
  ManagerResponse,
  ManagerSuccess
} from "../../src/ui/manager/types";
import {
  FIXTURE_CLOCK_START,
  createFixtureManagerTransport
} from "../../src/workbench/fixtureManagerTransport";
import {
  FIXTURE_IDS,
  getScenarioDefinition
} from "../../src/workbench/scenarios";

const query = { kind: "manager-query" } as const;
const createGroup = {
  kind: "manager-command",
  command: {
    kind: "createGroup",
    input: { name: "Agents", color: "blue" }
  }
} as const;

function createGroupNamed(name: string) {
  return {
    kind: "manager-command",
    command: {
      kind: "createGroup",
      input: { name, color: "blue" as const }
    }
  } as const;
}

function expectSuccess(
  response: ManagerResponse
): asserts response is ManagerSuccess {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(response.error.message);
}

it("returns deterministic seeded state through the typed manager transport", async () => {
  const fixture = createFixtureManagerTransport({ scenarioId: "wb:default" });
  const response = await fixture.transport.request(query);

  expectSuccess(response);
  expect(response.configuration).toEqual(
    getScenarioDefinition("wb:default").createSeed().configuration
  );
  expect(response.viewFixture).toEqual(
    getScenarioDefinition("wb:default").createSeed().viewFixture
  );
  expect(fixture.controls.commandLog()).toEqual([
    expect.objectContaining({
      recordType: "request",
      state: "resolved",
      mode: "fixture",
      scenarioId: "wb:default",
      sequence: 1,
      message: query,
      startedAt: FIXTURE_CLOCK_START,
      endedAt: FIXTURE_CLOCK_START,
      latencyMs: 0
    })
  ]);
});

it("applies commands through the manager router with deterministic identifiers and record ordering", async () => {
  const fixture = createFixtureManagerTransport({ scenarioId: "wb:default" });

  const before = await fixture.transport.request(query);
  expectSuccess(before);
  const mutated = await fixture.transport.request(createGroup);
  expectSuccess(mutated);
  const after = await fixture.transport.request(query);
  expectSuccess(after);

  const created = mutated.configuration.groups.find(
    (group) => group.name === "Agents"
  );
  expect(created?.id).toBe("10000000-0000-4000-8000-000000000001");
  expect(after.configuration).toEqual(mutated.configuration);
  expect(
    fixture.controls.commandLog().map((record) => record.sequence)
  ).toEqual([1, 2, 3]);
  expect(fixture.controls.commandLog().map((record) => record.state)).toEqual([
    "resolved",
    "resolved",
    "resolved"
  ]);
});

it("applies configured latency while keeping deterministic virtual timestamps", async () => {
  vi.useFakeTimers();
  try {
    const fixture = createFixtureManagerTransport({
      scenarioId: "wb:default",
      latencyMs: 120
    });
    const responsePromise = fixture.transport.request(query);

    expect(fixture.controls.commandLog()[0]).toEqual(
      expect.objectContaining({
        state: "pending",
        latencyMs: 120,
        startedAt: FIXTURE_CLOCK_START
      })
    );
    await vi.advanceTimersByTimeAsync(119);
    expect(fixture.controls.commandLog()[0]?.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    const response = await responsePromise;
    expectSuccess(response);
    expect(fixture.controls.commandLog()[0]).toEqual(
      expect.objectContaining({
        state: "resolved",
        startedAt: FIXTURE_CLOCK_START,
        endedAt: FIXTURE_CLOCK_START + 120,
        latencyMs: 120
      })
    );
  } finally {
    vi.useRealTimers();
  }
});

it("preserves request execution order when latency changes while requests are in flight", async () => {
  vi.useFakeTimers();
  try {
    const fixture = createFixtureManagerTransport({
      scenarioId: "wb:default",
      latencyMs: 250
    });
    const firstPromise = fixture.transport.request(createGroupNamed("First"));
    fixture.controls.setLatency(0);
    const secondPromise = fixture.transport.request(createGroupNamed("Second"));

    await vi.advanceTimersByTimeAsync(250);
    const first = await firstPromise;
    const second = await secondPromise;
    expectSuccess(first);
    expectSuccess(second);

    const firstGroup = second.configuration.groups.find(
      (group) => group.name === "First"
    );
    const secondGroup = second.configuration.groups.find(
      (group) => group.name === "Second"
    );
    expect(firstGroup?.id).toBe("10000000-0000-4000-8000-000000000001");
    expect(secondGroup?.id).toBe("10000000-0000-4000-8000-000000000002");
    expect(firstGroup?.defaultOrder).toBeLessThan(
      secondGroup?.defaultOrder ?? Number.MAX_SAFE_INTEGER
    );
    expect(
      fixture.controls.commandLog().map((record) => record.sequence)
    ).toEqual([1, 2]);
  } finally {
    vi.useRealTimers();
  }
});

it("consumes exact once failures only after a matching request", async () => {
  const fixture = createFixtureManagerTransport({
    scenarioId: "wb:default",
    failure: { mode: "command", scope: "once" }
  });

  const nonMatching = await fixture.transport.request(query);
  expectSuccess(nonMatching);

  const failed = await fixture.transport.request(createGroup);
  expect(failed).toEqual({
    ok: false,
    error: {
      kind: "transport",
      code: "FIXTURE_COMMAND_FAILURE",
      message: "Fixture command failure"
    }
  });

  const recovered = await fixture.transport.request(createGroup);
  expectSuccess(recovered);
  expect(
    recovered.configuration.groups.some((group) => group.name === "Agents")
  ).toBe(true);
  expect(fixture.controls.commandLog().map((record) => record.state)).toEqual([
    "resolved",
    "rejected",
    "resolved"
  ]);
});

it("injects validation failures without mutating the last valid configuration", async () => {
  const fixture = createFixtureManagerTransport({
    scenarioId: "wb:default",
    failure: { mode: "validation", scope: "persistent" }
  });
  const before = await fixture.transport.request(query);
  expectSuccess(before);

  const failed = await fixture.transport.request(createGroup);
  expect(failed).toEqual({
    ok: false,
    error: {
      kind: "validation",
      code: "FIXTURE_VALIDATION_FAILURE",
      message: "Fixture validation failure"
    }
  });

  const after = await fixture.transport.request(query);
  expectSuccess(after);
  expect(after.configuration).toEqual(before.configuration);
});

it("injects offline failures for queries and commands", async () => {
  const fixture = createFixtureManagerTransport({
    scenarioId: "wb:default",
    failure: { mode: "offline", scope: "persistent" }
  });

  for (const message of [query, createGroup]) {
    const response = await fixture.transport.request(message);
    expect(response).toEqual({
      ok: false,
      error: {
        kind: "offline",
        code: "OFFLINE",
        message: "Fixture transport is offline"
      }
    });
  }
  expect(fixture.controls.commandLog().map((record) => record.state)).toEqual([
    "rejected",
    "rejected"
  ]);
});

it("records loading requests as pending and releases queued requests in request order", async () => {
  const fixture = createFixtureManagerTransport({ scenarioId: "wb:loading" });
  const firstPromise = fixture.transport.request(query);
  const secondPromise = fixture.transport.request(query);
  const pending = fixture.controls.commandLog();

  expect(pending.map((record) => record.state)).toEqual(["pending", "pending"]);
  const requestIds = pending.map((record) => record.requestId);

  fixture.controls.setFailure({ mode: "query", scope: "once" });
  const released = await fixture.controls.releasePending();

  expect(released).toEqual({
    released: [
      { requestId: requestIds[0], finalState: "rejected" },
      { requestId: requestIds[1], finalState: "resolved" }
    ]
  });
  expect(await firstPromise).toEqual({
    ok: false,
    error: {
      kind: "transport",
      code: "FIXTURE_QUERY_FAILURE",
      message: "Fixture query failure"
    }
  });
  expectSuccess(await secondPromise);
  expect(fixture.controls.commandLog().map((record) => record.state)).toEqual([
    "rejected",
    "resolved"
  ]);
  expect(await fixture.controls.releasePending()).toEqual({ released: [] });
});

it("queues new requests after every held request when opening the pending gate", async () => {
  const fixture = createFixtureManagerTransport({
    scenarioId: "wb:loading",
    latencyMs: 0
  });
  const firstPromise = fixture.transport.request(createGroupNamed("First"));
  const secondPromise = fixture.transport.request(createGroupNamed("Second"));
  const heldRequestIds = fixture.controls
    .commandLog()
    .map((record) => record.requestId);

  const releasePromise = fixture.controls.releasePending();
  const thirdPromise = fixture.transport.request(createGroupNamed("Third"));

  expect(await releasePromise).toEqual({
    released: [
      { requestId: heldRequestIds[0], finalState: "resolved" },
      { requestId: heldRequestIds[1], finalState: "resolved" }
    ]
  });
  const first = await firstPromise;
  const second = await secondPromise;
  const third = await thirdPromise;
  expectSuccess(first);
  expectSuccess(second);
  expectSuccess(third);

  expect(
    second.configuration.groups.find((group) => group.name === "First")?.id
  ).toBe("10000000-0000-4000-8000-000000000001");
  expect(
    second.configuration.groups.find((group) => group.name === "Second")?.id
  ).toBe("10000000-0000-4000-8000-000000000002");
  expect(
    third.configuration.groups.find((group) => group.name === "Third")?.id
  ).toBe("10000000-0000-4000-8000-000000000003");
});

it("does not let an in-progress release drain requests from a reset generation", async () => {
  vi.useFakeTimers();
  try {
    const fixture = createFixtureManagerTransport({
      scenarioId: "wb:loading",
      latencyMs: 200
    });
    fixture.transport.request(query);
    fixture.transport.request(query);

    const releasePromise = fixture.controls.releasePending();
    await vi.advanceTimersByTimeAsync(0);
    await fixture.controls.reset();

    const freshPromise = fixture.transport.request(query);
    expect(fixture.controls.commandLog()[0]?.state).toBe("pending");

    await vi.advanceTimersByTimeAsync(200);
    expect(await releasePromise).toEqual({ released: [] });
    expect(fixture.controls.commandLog()[0]?.state).toBe("pending");

    const freshRelease = fixture.controls.releasePending();
    await vi.advanceTimersByTimeAsync(200);
    expect(await freshRelease).toEqual({
      released: [{ requestId: "manager-fixture-1", finalState: "resolved" }]
    });
    expectSuccess(await freshPromise);
  } finally {
    vi.useRealTimers();
  }
});

it("cancels delayed requests before reset initializes fresh fixture state", async () => {
  vi.useFakeTimers();
  try {
    const fixture = createFixtureManagerTransport({
      scenarioId: "wb:default",
      latencyMs: 200
    });
    const stalePromise = fixture.transport.request(createGroupNamed("Stale"));
    expect(fixture.controls.commandLog()[0]?.state).toBe("pending");

    await fixture.controls.reset();
    fixture.controls.setLatency(0);
    const freshPromise = fixture.transport.request(query);
    const stale = await stalePromise;
    const fresh = await freshPromise;

    expect(stale).toEqual({
      ok: false,
      error: {
        kind: "transport",
        code: "FIXTURE_RESET",
        message: "Fixture request was cleared by reset"
      }
    });
    expectSuccess(fresh);
    expect(
      fresh.configuration.groups.some((group) => group.name === "Stale")
    ).toBe(false);
    expect(fixture.controls.commandLog()).toHaveLength(1);
    expect(fixture.controls.commandLog()[0]).toEqual(
      expect.objectContaining({
        sequence: 1,
        state: "resolved",
        message: query
      })
    );

    await vi.advanceTimersByTimeAsync(200);
    expect(fixture.controls.commandLog()).toHaveLength(1);
    const after = await fixture.transport.request(query);
    expectSuccess(after);
    expect(
      after.configuration.groups.some((group) => group.name === "Stale")
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("reset restores the selected seed, clock, identifiers, latency, failure policy, pending gate, and log", async () => {
  const fixture = createFixtureManagerTransport({ scenarioId: "wb:default" });
  const firstMutation = await fixture.transport.request(createGroup);
  expectSuccess(firstMutation);
  const firstCreatedId = firstMutation.configuration.groups.find(
    (group) => group.name === "Agents"
  )?.id;

  fixture.controls.setLatency(250);
  fixture.controls.setFailure({ mode: "offline", scope: "persistent" });
  await fixture.controls.reset();

  expect(fixture.controls.commandLog()).toEqual([]);
  const seedResponse = await fixture.transport.request(query);
  expectSuccess(seedResponse);
  expect(seedResponse.configuration).toEqual(
    getScenarioDefinition("wb:default").createSeed().configuration
  );
  expect(fixture.controls.commandLog()[0]).toEqual(
    expect.objectContaining({
      sequence: 1,
      startedAt: FIXTURE_CLOCK_START,
      latencyMs: 0
    })
  );

  const secondMutation = await fixture.transport.request(createGroup);
  expectSuccess(secondMutation);
  const secondCreatedId = secondMutation.configuration.groups.find(
    (group) => group.name === "Agents"
  )?.id;
  expect(secondCreatedId).toBe(firstCreatedId);

  const loading = createFixtureManagerTransport({ scenarioId: "wb:loading" });
  const initialPending = loading.transport.request(query);
  await loading.controls.releasePending();
  expectSuccess(await initialPending);
  await loading.controls.reset();
  const resetPending = loading.transport.request(query);
  expect(loading.controls.commandLog()[0]?.state).toBe("pending");
  await loading.controls.releasePending();
  expectSuccess(await resetPending);
});

it("seeds populated persistent tabs in configuration and view fixtures", async () => {
  const fixture = createFixtureManagerTransport({
    scenarioId: "wb:populated-persistent-tabs"
  });
  const response = await fixture.transport.request(query);

  expectSuccess(response);
  expect(response.configuration.persistentTabs).toHaveLength(2);
  expect(
    response.viewFixture?.persistentTabsByGroup[FIXTURE_IDS.primaryGroup]
  ).toEqual({
    state: "populated",
    tabs: [
      "Docs — https://docs.example.test/",
      "Inbox — https://mail.example.test/inbox"
    ],
    persistentTabRecords: response.configuration.persistentTabs
  });
});

it("has no live Chrome or storage adapter imports", () => {
  const source = readFileSync(
    new URL("../../src/workbench/fixtureManagerTransport.ts", import.meta.url),
    "utf8"
  );

  expect(source).not.toMatch(/liveChromePort/);
  expect(source).not.toMatch(/chrome\./);
  expect(source).not.toMatch(/from\s+["'][^"']*storage[^"']*["']/);
});
