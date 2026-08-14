import { useState } from "react";
import type { ManagedGroup, Snapshot, UUID } from "../../../domain/types";
import type { ManagerCommandPayload, ManagerResponse } from "../types";
import { ConfirmationDialog } from "../components/ConfirmationDialog";

export interface SnapshotsPageProps {
  snapshots: readonly Snapshot[];
  groups?: readonly ManagedGroup[];
  command: (payload: ManagerCommandPayload) => Promise<ManagerResponse>;
  onBack: () => void;
}

type PendingAction =
  | { kind: "restore"; snapshot: Snapshot }
  | { kind: "update"; snapshot: Snapshot }
  | { kind: "delete"; snapshot: Snapshot };

export function SnapshotsPage({
  snapshots,
  groups = [],
  command,
  onBack
}: SnapshotsPageProps) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"browser" | UUID>("browser");
  const [renameId, setRenameId] = useState<UUID | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string>();
  const run = async (
    payload: ManagerCommandPayload
  ): Promise<ManagerResponse> => {
    const result = await command(payload);
    setError(result.ok ? undefined : result.error.message);
    return result;
  };

  return (
    <section aria-label="Snapshots content" className="snapshots-page">
      <button type="button" className="snapshots-back" onClick={onBack}>
        Back to Settings
      </button>
      <h1 data-page-heading="true">Snapshots</h1>
      {error ? (
        <p role="alert" className="snapshot-command-error">
          {error}
        </p>
      ) : null}
      <div className="snapshots-toolbar">
        <input
          aria-label="Snapshot name"
          placeholder="Snapshot name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          aria-label="Snapshot scope"
          value={scope}
          onChange={(event) =>
            setScope(
              event.target.value === "browser"
                ? "browser"
                : (event.target.value as UUID)
            )
          }
        >
          <option value="browser">Entire browser</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            void run({
              kind: "saveSnapshot",
              name,
              scope:
                scope === "browser"
                  ? { kind: "browser" }
                  : { kind: "group", managedGroupId: scope }
            }).then((result) => {
              if (result.ok) setName("");
            });
          }}
        >
          Save snapshot
        </button>
      </div>
      <div className="snapshots-scroll-body">
        <ul className="snapshots-list">
          {snapshots.map((snapshot) => (
            <li key={snapshot.id} className="snapshot-row">
              <div>
                <strong>{snapshot.name}</strong>
                <span>{snapshot.kind}</span>
              </div>
              <div className="snapshot-row-actions">
                {renameId === snapshot.id ? (
                  <>
                    <input
                      aria-label={`Rename ${snapshot.name}`}
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void run({
                          kind: "renameSnapshot",
                          snapshotId: snapshot.id,
                          name: renameValue
                        }).then((result) => {
                          if (result.ok) setRenameId(null);
                        });
                      }}
                    >
                      Save name
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setRenameId(snapshot.id);
                      setRenameValue(snapshot.name);
                    }}
                  >
                    Rename
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setPending({ kind: "update", snapshot })}
                >
                  Update
                </button>
                <button
                  type="button"
                  onClick={() => setPending({ kind: "restore", snapshot })}
                >
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => setPending({ kind: "delete", snapshot })}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {pending?.kind === "restore" ? (
        <ConfirmationDialog
          title="Restore snapshot?"
          message={`Restore "${pending.snapshot.name}" and reorganize open tabs.`}
          confirmLabel="Restore"
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            const result = await run({
              kind: "restoreSnapshot",
              snapshotId: pending.snapshot.id
            });
            if (result.ok) setPending(null);
          }}
        />
      ) : null}
      {pending?.kind === "update" ? (
        <ConfirmationDialog
          title="Update snapshot?"
          message={`Replace "${pending.snapshot.name}" with the current browser layout.`}
          confirmLabel="Update"
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            const result = await run({
              kind: "updateSnapshot",
              snapshotId: pending.snapshot.id
            });
            if (result.ok) setPending(null);
          }}
        />
      ) : null}
      {pending?.kind === "delete" ? (
        <ConfirmationDialog
          title="Delete snapshot?"
          message={`Delete "${pending.snapshot.name}" permanently.`}
          confirmLabel="Delete"
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            const result = await run({
              kind: "deleteSnapshot",
              snapshotId: pending.snapshot.id
            });
            if (result.ok) setPending(null);
          }}
        />
      ) : null}
    </section>
  );
}
