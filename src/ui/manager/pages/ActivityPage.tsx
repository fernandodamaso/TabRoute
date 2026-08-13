import { useMemo, useState } from "react";
import type { ActivityEntry, UndoRecord } from "../../../domain/types";
import type { ManagerCommandPayload } from "../types";
import { ConfirmationDialog } from "../components/ConfirmationDialog";

export interface ActivityPageProps {
  activity: readonly ActivityEntry[];
  availableUndo?: UndoRecord;
  command: (payload: ManagerCommandPayload) => Promise<void>;
}

function groupLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  return date.toLocaleDateString();
}

export function ActivityPage({ activity, availableUndo, command }: ActivityPageProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | ActivityEntry["result"]>("all");
  const [confirmClear, setConfirmClear] = useState(false);

  const filtered = useMemo(() => {
    return activity.filter((entry) => {
      if (status !== "all" && entry.result !== status) return false;
      if (!query.trim()) return true;
      const needle = query.trim().toLowerCase();
      return (
        entry.action.toLowerCase().includes(needle) ||
        entry.affectedUrls.some((url) => url.toLowerCase().includes(needle))
      );
    });
  }, [activity, query, status]);

  const grouped = useMemo(() => {
    const map = new Map<string, ActivityEntry[]>();
    for (const entry of filtered) {
      const label = groupLabel(entry.createdAt);
      const list = map.get(label) ?? [];
      list.push(entry);
      map.set(label, list);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <section aria-label="Activity content" className="manager-page-content activity-page">
      <h1 data-page-heading="true">Activity</h1>
      <div className="activity-toolbar">
        <input
          aria-label="Search activity"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as typeof status)
          }
        >
          <option value="all">All</option>
          <option value="success">Success</option>
          <option value="degraded">Degraded</option>
          <option value="failure">Failure</option>
          <option value="retry">Retry</option>
        </select>
        <button type="button" onClick={() => setConfirmClear(true)}>
          Clear history
        </button>
      </div>
      <div className="activity-scroll-body">
        {grouped.map(([label, entries]) => (
          <section key={label} aria-label={label}>
            <h2>{label}</h2>
            <ul>
              {entries.map((entry) => (
                <li key={entry.id}>
                  <span>{entry.action}</span>
                  <span>{entry.result}</span>
                  {entry.undoId &&
                  availableUndo &&
                  entry.undoId === availableUndo.id ? (
                    <button
                      type="button"
                      onClick={() =>
                        void command({ kind: "undo", undoId: entry.undoId! })
                      }
                    >
                      Undo
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {confirmClear ? (
        <ConfirmationDialog
          title="Clear activity history?"
          message="This removes local activity entries."
          confirmLabel="Clear"
          onConfirm={() => {
            setConfirmClear(false);
            void command({ kind: "clearActivity" });
          }}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}
    </section>
  );
}
