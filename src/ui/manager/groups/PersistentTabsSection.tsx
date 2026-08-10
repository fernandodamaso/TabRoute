export type PersistentTabsState = "loading" | "empty" | "populated" | "disabled" | "error";

export function PersistentTabsSection({ state = "empty", tabs = [] }: { state?: PersistentTabsState; tabs?: string[] }) {
  return <section className="manager-card persistent-tabs" aria-labelledby="persistent-tabs-heading">
    <div className="section-title"><h2 id="persistent-tabs-heading">Persistent tabs</h2><span>FDM-592</span></div>
    {state === "loading" && <p role="status">Loading persistent tabs…</p>}
    {state === "empty" && <p>No persistent tabs</p>}
    {state === "disabled" && <p>Persistent tabs unavailable while this group is off.</p>}
    {state === "error" && <p role="alert">Unable to load persistent tabs.</p>}
    {state === "populated" && <ul>{tabs.map((tab) => <li key={tab}>{tab}</li>)}</ul>}
    <p className="manager-note">Persistent-tab repair is not part of this slice.</p>
  </section>;
}
