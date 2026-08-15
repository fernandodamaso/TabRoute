import { expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createDiagnosticsManagerPort } from "../../src/background/managerMessageRouter";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";

it("emits OFFLINE when the offline signal is true", async () => {
  const session = createMemorySessionRepository();
  const port = createDiagnosticsManagerPort({
    local: createMemoryLocalRepository(),
    session,
    getConfiguration: () => createDefaultConfiguration(),
    offline: () => true
  });
  const fixture = await port.query();
  expect(fixture.diagnostics?.warnings).toContain("OFFLINE");
});

it("emits SYNC_INVALID from lastSyncInvalid without pending revision", async () => {
  const session = createMemorySessionRepository();
  await session.updateRuntime({ lastSyncInvalid: true });
  const port = createDiagnosticsManagerPort({
    local: createMemoryLocalRepository(),
    session,
    getConfiguration: () => createDefaultConfiguration(),
    offline: () => false
  });
  const fixture = await port.query();
  expect(fixture.diagnostics?.warnings).toContain("SYNC_INVALID");
  expect(fixture.diagnostics?.warnings).not.toContain("SYNC_INCOMPLETE");
});

it("prefers SYNC_INCOMPLETE over SYNC_INVALID when a revision is pending", async () => {
  const session = createMemorySessionRepository();
  await session.updateRuntime({
    pendingSyncRevision: "00000000-0000-4000-8000-000000000099",
    lastSyncInvalid: true
  });
  const port = createDiagnosticsManagerPort({
    local: createMemoryLocalRepository(),
    session,
    getConfiguration: () => createDefaultConfiguration(),
    offline: () => false
  });
  const fixture = await port.query();
  expect(fixture.diagnostics?.warnings).toContain("SYNC_INCOMPLETE");
  expect(fixture.diagnostics?.warnings).not.toContain("SYNC_INVALID");
});
