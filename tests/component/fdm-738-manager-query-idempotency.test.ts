import { expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import {
  createFixtureActivityManagerPort,
  createFixtureDiagnosticsManagerPort,
  createFixtureSnapshotManagerPort,
  createManagerMessageRouter
} from "../../src/background/managerMessageRouter";
import type { ManagerViewFixture } from "../../src/ui/manager/types";

it("keeps a pending rule draft visible when a manager query is retried while the first request is still live", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  let viewFixture: ManagerViewFixture = { persistentTabsByGroup: {} };
  let pendingDraft: { host: string; url: string } | undefined = {
    host: "example.com",
    url: "https://example.com/"
  };

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
    consumePendingRuleDraft: async () => {
      const current = pendingDraft;
      pendingDraft = undefined;
      return current;
    }
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
          url: "https://example.com/"
        }
      }
    });
  }
});
