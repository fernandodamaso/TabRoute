import { expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import {
  createFixtureActivityManagerPort,
  createFixtureDiagnosticsManagerPort,
  createFixtureSnapshotManagerPort,
  createManagerMessageRouter
} from "../../src/background/managerMessageRouter";
import { createPendingRuleDraftDelivery } from "../../src/background/pendingRuleDraftDelivery";
import {
  PENDING_RULE_DRAFT_KEY,
  readPendingRuleDraft
} from "../../src/controller/executeUserCommand";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import type { ManagerViewFixture } from "../../src/ui/manager/types";

it("keeps a pending rule draft visible when a manager query is retried while the first request is still live", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const session = createMemorySessionRepository();
  const delivery = createPendingRuleDraftDelivery(session);
  let viewFixture: ManagerViewFixture = { persistentTabsByGroup: {} };
  await session.updateRuntime({
    [PENDING_RULE_DRAFT_KEY]: {
      schemaVersion: 1,
      host: "example.com",
      url: "https://example.com/",
      createdAt: 1
    }
  });

  const router = createManagerMessageRouter({
    repository: { save: async () => undefined },
    controller: {
      getConfiguration: () => configuration,
      replaceConfiguration: async () => undefined
    },
    activity: createFixtureActivityManagerPort({
      getViewFixture: () => viewFixture,
      setViewFixture: (next) => {
        viewFixture = next;
      }
    }),
    snapshots: createFixtureSnapshotManagerPort({
      getViewFixture: () => viewFixture,
      setViewFixture: (next) => {
        viewFixture = next;
      },
      getConfiguration: () => configuration
    }),
    diagnostics: createFixtureDiagnosticsManagerPort({
      getViewFixture: () => viewFixture,
      setViewFixture: (next) => {
        viewFixture = next;
      },
      getConfiguration: () => configuration
    }),
    session,
    consumePendingRuleDraft: () => delivery.read()
  });

  const [firstResponse, retryResponse] = await Promise.all([
    router.handle({ kind: "manager-query" }),
    router.handle({ kind: "manager-query" })
  ]);

  for (const response of [firstResponse, retryResponse]) {
    expect(response).toMatchObject({
      ok: true,
      viewFixture: {
        pendingRuleDraft: {
          host: "example.com",
          url: "https://example.com/",
          createdAt: 1
        }
      }
    });
  }
  expect(await readPendingRuleDraft(session)).toMatchObject({ createdAt: 1 });
});

it("does not let a stale acknowledgement clear a newer pending rule draft", async () => {
  const session = createMemorySessionRepository();
  const delivery = createPendingRuleDraftDelivery(session);
  const firstDraft = {
    schemaVersion: 1 as const,
    host: "first.example.com",
    url: "https://first.example.com/",
    createdAt: 1
  };
  const newerDraft = {
    schemaVersion: 1 as const,
    host: "new.example.com",
    url: "https://new.example.com/",
    createdAt: 2
  };

  await delivery.runExclusive(() =>
    session.updateRuntime({ [PENDING_RULE_DRAFT_KEY]: firstDraft })
  );
  const delivered = await delivery.read();
  expect(delivered?.createdAt).toBe(1);

  await delivery.runExclusive(() =>
    session.updateRuntime({ [PENDING_RULE_DRAFT_KEY]: newerDraft })
  );

  expect(await delivery.acknowledge(1)).toBe(false);
  expect(await readPendingRuleDraft(session)).toEqual(newerDraft);

  expect(await delivery.acknowledge(2)).toBe(true);
  expect(await readPendingRuleDraft(session)).toBeUndefined();
});
