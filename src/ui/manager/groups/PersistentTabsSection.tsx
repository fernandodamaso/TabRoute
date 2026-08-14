import type { PersistentTab, UUID } from "../../../domain/types";
import type { ManagerCommand, ManagerResponse } from "../types";

export type PersistentTabsState =
  "loading" | "empty" | "populated" | "disabled" | "error";

function displayLabel(tab: PersistentTab): string {
  try {
    const host = new URL(tab.canonicalUrl).hostname;
    return host || tab.canonicalUrl;
  } catch {
    return tab.canonicalUrl;
  }
}

export function PersistentTabsSection({
  state = "empty",
  tabs = [],
  managedGroupId,
  groupEnabled = true,
  command
}: {
  state?: PersistentTabsState;
  tabs?: readonly PersistentTab[];
  managedGroupId?: UUID;
  groupEnabled?: boolean;
  command?: (message: ManagerCommand) => Promise<ManagerResponse>;
}) {
  const effectiveState = !groupEnabled ? "disabled" : state;
  const sorted = [...tabs].sort((left, right) => left.order - right.order);

  return (
    <section
      className="manager-card persistent-tabs"
      aria-labelledby="persistent-tabs-heading"
    >
      <div className="section-title">
        <h2 id="persistent-tabs-heading">Persistent tabs</h2>
      </div>
      {effectiveState === "loading" && (
        <p role="status">Loading persistent tabs…</p>
      )}
      {effectiveState === "empty" && <p>No persistent tabs</p>}
      {effectiveState === "disabled" && (
        <p>Persistent tabs unavailable while this group is off.</p>
      )}
      {effectiveState === "error" && (
        <p role="alert">Unable to load persistent tabs.</p>
      )}
      {effectiveState === "populated" && (
        <ul className="persistent-tab-list">
          {sorted.map((tab) => (
            <li key={tab.id}>
              <span>{displayLabel(tab)}</span>
              {command && (
                <button
                  type="button"
                  aria-label={`Remove ${displayLabel(tab)}`}
                  onClick={() =>
                    void command({
                      kind: "manager-command",
                      command: {
                        kind: "removePersistent",
                        persistentTabId: tab.id
                      }
                    })
                  }
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {command &&
        groupEnabled &&
        managedGroupId &&
        effectiveState !== "loading" &&
        effectiveState !== "error" && (
          <button
            type="button"
            className="persistent-pin-group"
            onClick={() =>
              void command({
                kind: "manager-command",
                command: {
                  kind: "pinGroup",
                  managedGroupId
                }
              })
            }
          >
            Pin group
          </button>
        )}
    </section>
  );
}
