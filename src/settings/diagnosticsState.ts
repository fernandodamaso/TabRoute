import type { StorageDiagnostics } from "../domain/types";

export type DiagnosticsWarningCode =
  | "SYNC_INCOMPLETE"
  | "SYNC_INVALID"
  | "SYNC_QUOTA"
  | "LOCAL_BUDGET"
  | "OFFLINE";

export interface DiagnosticsViewState {
  storage: StorageDiagnostics;
  warnings: DiagnosticsWarningCode[];
}

export function buildDiagnosticsWarnings(input: {
  storage: StorageDiagnostics;
  pendingSyncRevision?: string;
  syncInvalid: boolean;
  offline: boolean;
}): DiagnosticsWarningCode[] {
  const warnings: DiagnosticsWarningCode[] = [];
  if (input.offline) warnings.push("OFFLINE");
  if (input.pendingSyncRevision) warnings.push("SYNC_INCOMPLETE");
  else if (input.syncInvalid) warnings.push("SYNC_INVALID");
  if (input.storage.syncBytes > input.storage.syncQuotaBytes) warnings.push("SYNC_QUOTA");
  if (input.storage.localBytes > input.storage.localSoftBudgetBytes) warnings.push("LOCAL_BUDGET");
  return warnings;
}

export function formatDiagnosticsReport(state: DiagnosticsViewState): string {
  const lines = [
    "TabRoute diagnostics",
    `Sync: ${state.storage.syncBytes}/${state.storage.syncQuotaBytes} bytes (${state.storage.syncItemCount} items)`,
    `Local: ${state.storage.localBytes}/${state.storage.localSoftBudgetBytes} soft budget`,
    `Session: ${state.storage.sessionBytes}/${state.storage.sessionQuotaBytes} bytes`
  ];
  if (state.warnings.length > 0) {
    lines.push(`Warnings: ${state.warnings.join(", ")}`);
  }
  return lines.join("\n");
}
