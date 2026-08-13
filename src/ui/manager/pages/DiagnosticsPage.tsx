import type { DiagnosticsViewState } from "../../../settings/diagnosticsState";
import { formatDiagnosticsReport } from "../../../settings/diagnosticsState";
import type { ManagerCommandPayload } from "../types";

export interface DiagnosticsPageProps {
  diagnostics: DiagnosticsViewState;
  command: (payload: ManagerCommandPayload) => Promise<void>;
  onBack: () => void;
}

const WARNING_COPY: Record<DiagnosticsViewState["warnings"][number], string> = {
  SYNC_INCOMPLETE: "Sync revision is incomplete. Retry or recheck when connectivity returns.",
  SYNC_INVALID: "Remote configuration is invalid. Recheck after fixing sync data.",
  SYNC_QUOTA: "Sync storage quota is exceeded.",
  LOCAL_BUDGET: "Local storage is above the soft budget.",
  OFFLINE: "Chrome runtime is offline."
};

export function DiagnosticsPage({ diagnostics, command, onBack }: DiagnosticsPageProps) {
  const showRetry = diagnostics.warnings.includes("SYNC_INCOMPLETE");

  return (
    <section aria-label="Diagnostics content" className="diagnostics-page">
      <button type="button" className="snapshots-back" onClick={onBack}>
        Back to Settings
      </button>
      <h1 data-page-heading="true">Diagnostics</h1>
      <div className="diagnostics-scroll-body">
        {diagnostics.warnings.map((warning) => (
          <div key={warning} role="alert" className="diagnostics-warning">
            <strong>{warning}</strong> {WARNING_COPY[warning]}
          </div>
        ))}
        <section className="manager-card" aria-label="Storage diagnostics">
          <h2>Storage</h2>
          <p>Sync: {diagnostics.storage.syncBytes}/{diagnostics.storage.syncQuotaBytes} bytes ({diagnostics.storage.syncItemCount} items)</p>
          <p>Local: {diagnostics.storage.localBytes}/{diagnostics.storage.localSoftBudgetBytes} soft budget</p>
          <p>Session: {diagnostics.storage.sessionBytes}/{diagnostics.storage.sessionQuotaBytes} bytes</p>
        </section>
        <div className="diagnostics-actions">
          <button type="button" onClick={() => void command({ kind: "diagnosticsRecheck" })}>
            Recheck
          </button>
          {showRetry ? (
            <button type="button" onClick={() => void command({ kind: "retryPendingSync" })}>
              Retry sync
            </button>
          ) : null}
          <button type="button" onClick={() => void command({ kind: "reconcileAll" })}>
            Reconcile all tabs
          </button>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(formatDiagnosticsReport(diagnostics))}
          >
            Copy report
          </button>
          <button type="button" onClick={() => void command({ kind: "exportActivityLog" })}>
            Export activity log
          </button>
        </div>
      </div>
    </section>
  );
}
