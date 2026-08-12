import type { ManagedGroup } from "../../../domain/types";
import { renderGroupTitle } from "../../../groups/displayTitle";
import type { ManagerCommand, ManagerResponse, PersistentTabsViewFixture } from "../types";
import { PersistentTabsSection } from "./PersistentTabsSection";
import { useGroupAutosave } from "./useGroupAutosave";

const colors: ManagedGroup["color"][] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

export function GroupInspector({ group, command, viewFixture, onNavigate }: {
  group: ManagedGroup;
  command: (message: ManagerCommand) => Promise<ManagerResponse>;
  viewFixture?: PersistentTabsViewFixture;
  onNavigate?: (route: "rules") => void;
}) {
  const autosave = useGroupAutosave({
    groupId: group.id,
    save: async (patch) => {
      const response = await command({ kind: "manager-command", command: { kind: "updateGroup", groupId: group.id, patch } });
      return { ok: response.ok };
    }
  });
  return <article className="groups-inspector groups-scroll-owner" aria-label={`${renderGroupTitle(group)} inspector`}>
    <div className="inspector-heading"><div><p className="manager-eyebrow">IDENTITY</p><h2>{renderGroupTitle(group)}</h2></div><span role="status" className={`autosave-status autosave-${autosave.status.toLowerCase()}`}>{autosave.status}</span></div>
    <section className="manager-card" aria-labelledby="identity-heading"><h3 id="identity-heading">Identity</h3>
      <label>Name<input aria-label="Name" value={group.name} onChange={(event) => autosave.update({ name: event.target.value })} onBlur={autosave.flush} /></label>
      <label>Emoji<input aria-label="Emoji" value={group.emoji ?? ""} onChange={(event) => autosave.update({ emoji: event.target.value || undefined })} onBlur={autosave.flush} /></label>
      <label>Chrome color<select aria-label="Chrome color" value={group.color} onChange={(event) => autosave.update({ color: event.target.value as ManagedGroup["color"] }, true)}>{colors.map((color) => <option key={color} value={color}>{color}</option>)}</select></label>
      <label className="toggle-row"><input aria-label="Group On" type="checkbox" checked={group.enabled} disabled={group.isFallback} onChange={(event) => autosave.update({ enabled: event.target.checked }, true)} /> Group On</label>
      {group.isFallback && <p className="manager-note">Fallback group</p>}
    </section>
    <section className="manager-card" aria-labelledby="routing-heading"><div className="section-title"><h3 id="routing-heading">Routing rules</h3><button type="button" onClick={() => onNavigate?.("rules")}>Open Rules</button></div><p className="manager-note">Rules that target {renderGroupTitle(group)}.</p></section>
    <section className="manager-card" aria-labelledby="behavior-heading"><h3 id="behavior-heading">Behavior</h3><p className="manager-note">Group presentation and pause behavior use the typed controller boundary.</p></section>
    <PersistentTabsSection
      state={viewFixture?.state ?? (group.enabled ? "empty" : "disabled")}
      tabs={viewFixture?.tabs ? [...viewFixture.tabs] : []}
    />
  </article>;
}
