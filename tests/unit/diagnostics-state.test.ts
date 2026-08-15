import { describe, expect, it } from "vitest";
import type { StorageDiagnostics } from "../../src/domain/types";
import { buildDiagnosticsWarnings } from "../../src/settings/diagnosticsState";

const storage: StorageDiagnostics = {
  syncBytes: 1000,
  syncQuotaBytes: 102400,
  syncLargestItemBytes: 500,
  syncQuotaBytesPerItem: 8192,
  syncItemCount: 3,
  syncMaxItems: 512,
  localBytes: 1000,
  localSoftBudgetBytes: 9437184,
  localQuotaBytes: 10485760,
  sessionBytes: 100,
  sessionQuotaBytes: 10485760
};

describe("diagnostics warnings", () => {
  it("flags SYNC_INCOMPLETE when a sync revision is pending", () => {
    expect(
      buildDiagnosticsWarnings({
        storage,
        pendingSyncRevision: "rev-pending",
        syncInvalid: false,
        offline: false
      })
    ).toContain("SYNC_INCOMPLETE");
  });

  it("flags SYNC_INVALID without retry", () => {
    const warnings = buildDiagnosticsWarnings({
      storage,
      pendingSyncRevision: undefined,
      syncInvalid: true,
      offline: false
    });
    expect(warnings).toContain("SYNC_INVALID");
    expect(warnings).not.toContain("SYNC_INCOMPLETE");
  });

  it("flags SYNC_QUOTA when sync bytes exceed quota", () => {
    expect(
      buildDiagnosticsWarnings({
        storage: { ...storage, syncBytes: storage.syncQuotaBytes + 1 },
        pendingSyncRevision: undefined,
        syncInvalid: false,
        offline: false
      })
    ).toContain("SYNC_QUOTA");
  });

  it("flags LOCAL_BUDGET when local bytes exceed the soft budget", () => {
    expect(
      buildDiagnosticsWarnings({
        storage: { ...storage, localBytes: storage.localSoftBudgetBytes + 1 },
        pendingSyncRevision: undefined,
        syncInvalid: false,
        offline: false
      })
    ).toContain("LOCAL_BUDGET");
  });

  it("flags OFFLINE when transport is offline", () => {
    expect(
      buildDiagnosticsWarnings({
        storage,
        pendingSyncRevision: undefined,
        syncInvalid: false,
        offline: true
      })
    ).toContain("OFFLINE");
  });
});
