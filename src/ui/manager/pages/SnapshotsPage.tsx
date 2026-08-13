import { useState } from "react";
import type { Snapshot, UUID } from "../../../domain/types";
import type { ManagerCommandPayload } from "../types";
import { ConfirmationDialog } from "../components/ConfirmationDialog";

export interface SnapshotsPageProps {
  snapshots: readonly Snapshot[];
  command: (payload: ManagerCommandPayload) => Promise<void>;
  onBack: () => void;
}

type PendingAction =
  | { kind: "restore"; snapshot: Snapshot }
  | { kind: "update"; snapshot: Snapshot }
  | { kind: "delete"; snapshot: Snapshot };

export function SnapshotsPage({ snapshots, command, onBack }: SnapshotsPageProps) {
  const [name, setName] = useState("");
  const [renameId, setRenameId] = useState<UUID | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);

  return (
    <section aria-label="Snapshots content" className="snapshots-page">
      <button type="button" className="snapshots-back" onClick={onBack}>
        Back to Settings
      </button>
      <h1 data-page-heading="true">Snapshots</h1>
      <div className="snapshots-toolbar">
        <input
          aria-label="Snapshot name"
          placeholder="Snapshot name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            void command({ kind: "saveSnapshot", name, scope: { kind: "browser" } });
            setName("");
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
                        void command({
                          kind: "renameSnapshot",
                          snapshotId: snapshot.id,
                          name: renameValue
                        });
                        setRenameId(null);
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
          onConfirm={() => {
            setPending(null);
            void command({
              kind: "restoreSnapshot",
              snapshotId: pending.snapshot.id
            });
          }}
        />
      ) : null}
      {pending?.kind === "update" ? (
        <ConfirmationDialog
          title="Update snapshot?"
          message={`Replace "${pending.snapshot.name}" with the current browser layout.`}
          confirmLabel="Update"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void command({
              kind: "updateSnapshot",
              snapshotId: pending.snapshot.id
            });
          }}
        />
      ) : null}
      {pending?.kind === "delete" ? (
        <ConfirmationDialog
          title="Delete snapshot?"
          message={`Delete "${pending.snapshot.name}" permanently.`}
          confirmLabel="Delete"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void command({
              kind: "deleteSnapshot",
              snapshotId: pending.snapshot.id
            });
          }}
        />
      ) : null}
    </section>
  );
}
