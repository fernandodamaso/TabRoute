import type { ManagedGroup, UUID } from "../../../domain/types";
import { renderGroupTitle } from "../../../groups/displayTitle";

export function GroupNavigator({ groups, selectedId, onSelect, onAdd, onDelete }: {
  groups: ManagedGroup[];
  selectedId: UUID;
  onSelect: (id: UUID) => void;
  onAdd: () => void;
  onDelete: (id: UUID) => void;
}) {
  const ordered = [...groups].sort((left, right) => left.defaultOrder - right.defaultOrder);
  const selected = groups.find((group) => group.id === selectedId);
  return <aside className="groups-navigator" aria-label="Groups navigator">
    <div className="groups-navigator-heading"><strong>Groups</strong><button type="button" onClick={onAdd}>Add group</button></div>
    <div className="groups-list">
      {ordered.map((group) => <button key={group.id} type="button" aria-pressed={group.id === selectedId} onClick={() => onSelect(group.id)}>{renderGroupTitle(group)}{group.isFallback && <span className="group-role">Fallback</span>}</button>)}
    </div>
    {selected && !selected.isFallback && <button type="button" className="group-delete" onClick={() => onDelete(selected.id)}>Delete group {renderGroupTitle(selected)}</button>}
  </aside>;
}
