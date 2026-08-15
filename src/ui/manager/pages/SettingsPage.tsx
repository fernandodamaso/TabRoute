import { useEffect, useRef, useState } from "react";
import type { Configuration, DuplicatePolicy } from "../../../domain/types";
import { exportPortableConfiguration } from "../../../settings/portableConfiguration";
import type { ManagerCommandPayload, ManagerResponse } from "../types";

export interface SettingsPageProps {
  configuration: Configuration;
  command: (payload: ManagerCommandPayload) => Promise<ManagerResponse>;
  onOpenSnapshots: () => void;
  onOpenDiagnostics: () => void;
}

export function SettingsPage({
  configuration,
  command,
  onOpenSnapshots,
  onOpenDiagnostics
}: SettingsPageProps) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const intervalEditingRef = useRef(false);
  const patternEditingRef = useRef(false);
  const [intervalDraft, setIntervalDraft] = useState(
    String(configuration.snapshotIntervalMinutes)
  );
  const [patternDraft, setPatternDraft] = useState(
    configuration.duplicateSettings.globalPolicy.kind === "pattern"
      ? configuration.duplicateSettings.globalPolicy.pattern
      : ""
  );
  const [pendingPatternMode, setPendingPatternMode] = useState(false);
  const [importError, setImportError] = useState<string>();

  useEffect(() => {
    if (!intervalEditingRef.current) {
      setIntervalDraft(String(configuration.snapshotIntervalMinutes));
    }
  }, [configuration.snapshotIntervalMinutes]);

  useEffect(() => {
    if (
      !patternEditingRef.current &&
      configuration.duplicateSettings.globalPolicy.kind === "pattern"
    ) {
      setPatternDraft(configuration.duplicateSettings.globalPolicy.pattern);
      setPendingPatternMode(false);
    }
  }, [configuration.duplicateSettings.globalPolicy]);

  async function exportConfigurationFile() {
    const result = await command({ kind: "exportConfiguration" });
    if (!result.ok) return;
    const blob = new Blob([exportPortableConfiguration(result.configuration)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "tabroute-configuration.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function duplicatePolicyForSelection(kind: string): DuplicatePolicy {
    return {
      kind: kind as Exclude<DuplicatePolicy["kind"], "pattern">
    } as DuplicatePolicy;
  }

  const selectedDuplicatePolicy = pendingPatternMode
    ? "pattern"
    : configuration.duplicateSettings.globalPolicy.kind;

  return (
    <section aria-label="Settings content" className="settings-page">
      <h1 data-page-heading="true">Settings</h1>
      <div className="settings-scroll-body">
        <section className="manager-card" aria-label="Automation">
          <h2>Automation</h2>
          <label className="toggle-row">
            <input
              aria-label="Enable automation"
              type="checkbox"
              checked={configuration.automationEnabled}
              onChange={(event) =>
                void command({
                  kind: "setAutomationEnabled",
                  enabled: event.target.checked
                })
              }
            />
            Enable automation
          </label>
          <label className="toggle-row">
            <input
              aria-label="Restore persistent groups"
              type="checkbox"
              checked={configuration.restorePersistentGroups ?? true}
              onChange={(event) =>
                void command({
                  kind: "setRestorePersistentGroups",
                  enabled: event.target.checked
                })
              }
            />
            Restore persistent groups
          </label>
        </section>

        <section className="manager-card" aria-label="Duplicates">
          <h2>Duplicates</h2>
          <label>
            Duplicate policy
            <select
              aria-label="Duplicate policy"
              value={selectedDuplicatePolicy}
              onChange={(event) => {
                const kind = event.target.value;
                if (kind === "pattern") {
                  if (
                    configuration.duplicateSettings.globalPolicy.kind !==
                    "pattern"
                  ) {
                    setPatternDraft("");
                  }
                  setPendingPatternMode(true);
                  return;
                }
                setPendingPatternMode(false);
                void command({
                  kind: "setDuplicateSettings",
                  settings: {
                    ...configuration.duplicateSettings,
                    globalPolicy: duplicatePolicyForSelection(kind)
                  }
                });
              }}
            >
              <option value="allow">Allow duplicates</option>
              <option value="exactUrl">Exact URL</option>
              <option value="fragmentlessUrl">Fragmentless URL</option>
              <option value="domain">Domain</option>
              <option value="urlAndTitle">URL and title</option>
              <option value="pattern">Pattern</option>
            </select>
          </label>
          {selectedDuplicatePolicy === "pattern" ? (
            <label>
              Duplicate pattern
              <input
                aria-label="Duplicate pattern"
                type="text"
                value={patternDraft}
                onFocus={() => {
                  patternEditingRef.current = true;
                }}
                onChange={(event) => setPatternDraft(event.target.value)}
                onBlur={() => {
                  patternEditingRef.current = false;
                  const pattern = patternDraft.trim();
                  if (!pattern) {
                    if (
                      configuration.duplicateSettings.globalPolicy.kind ===
                      "pattern"
                    ) {
                      setPatternDraft(
                        configuration.duplicateSettings.globalPolicy.pattern
                      );
                    } else {
                      setPatternDraft("");
                      setPendingPatternMode(false);
                    }
                    return;
                  }
                  void command({
                    kind: "setDuplicateSettings",
                    settings: {
                      ...configuration.duplicateSettings,
                      globalPolicy: { kind: "pattern", pattern }
                    }
                  }).then((result) => {
                    if (result.ok) setPendingPatternMode(false);
                  });
                }}
              />
            </label>
          ) : null}
        </section>

        <section className="manager-card" aria-label="Snapshots settings">
          <h2>Snapshots</h2>
          <label>
            Snapshot interval minutes
            <input
              aria-label="Snapshot interval minutes"
              type="number"
              min="1"
              value={intervalDraft}
              onFocus={() => {
                intervalEditingRef.current = true;
              }}
              onChange={(event) => setIntervalDraft(event.target.value)}
              onBlur={() => {
                intervalEditingRef.current = false;
                const minutes = Number(intervalDraft);
                if (!Number.isFinite(minutes) || minutes <= 0) {
                  setIntervalDraft(
                    String(configuration.snapshotIntervalMinutes)
                  );
                  return;
                }
                void command({ kind: "setSnapshotIntervalMinutes", minutes });
              }}
            />
          </label>
        </section>

        <section className="manager-card" aria-label="Data actions">
          <h2>Data</h2>
          {importError ? (
            <p role="alert" className="settings-import-error">
              {importError}
            </p>
          ) : null}
          <div className="settings-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void exportConfigurationFile()}
            >
              Export configuration
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
            >
              Import configuration
            </button>
            <input
              ref={importInputRef}
              className="sr-only"
              aria-label="Import configuration"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void file.text().then(async (json) => {
                  const result = await command({
                    kind: "importConfiguration",
                    json
                  });
                  if (!result.ok) {
                    setImportError(result.error.message);
                    return;
                  }
                  setImportError(undefined);
                });
              }}
            />
            <button
              type="button"
              className="primary-button snapshots-entry"
              onClick={onOpenSnapshots}
            >
              Snapshots
            </button>
            <button type="button" onClick={onOpenDiagnostics}>
              Diagnostics
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}
