import { expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createConfigurationSyncCoordinator } from "../../src/state/configurationSyncCoordinator";

it("serializes concurrent sync applies so one revision runs side effects once", async () => {
  const configuration = createDefaultConfiguration(
    () => "11111111-1111-4111-8111-111111111111"
  );
  let acknowledged = false;
  let inFlight = 0;
  let maxInFlight = 0;
  let refreshMenusCalls = 0;

  const coordinator = createConfigurationSyncCoordinator({
    repository: {
      async applySyncChange() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return acknowledged
          ? {
              kind: "already-applied" as const,
              configuration,
              revisionId: "local-revision"
            }
          : {
              kind: "applied" as const,
              configuration,
              revisionId: "local-revision"
            };
      },
      async markControllerRevisionApplied() {
        acknowledged = true;
      }
    },
    callbacks: {
      async replaceConfiguration() {},
      async refreshMenus() {
        refreshMenusCalls += 1;
      },
      async refreshAlarms() {},
      async refreshViews() {},
      async scheduleRetry() {}
    }
  });

  const results = await Promise.all([
    coordinator.applySyncChange(["config:v1:head"]),
    coordinator.applySyncChange(["config:v1:revision:local-revision:0"])
  ]);

  expect(maxInFlight).toBe(1);
  expect(refreshMenusCalls).toBe(1);
  expect(results.map((result) => result.kind)).toEqual([
    "applied",
    "already-applied"
  ]);
});
