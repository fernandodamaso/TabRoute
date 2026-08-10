import { useMemo, useState } from "react";
import type { Configuration, UUID } from "../../../domain/types";
import type { ManagerCommand, ManagerResponse } from "../types";
import { GroupInspector } from "../groups/GroupInspector";
import { GroupNavigator } from "../groups/GroupNavigator";

export function GroupsPage({ configuration, command, onNavigate }: {
  configuration: Configuration;
  command: (message: ManagerCommand) => Promise<ManagerResponse>;
  onNavigate?: (route: "rules") => void;
}) {
  const firstId = useMemo(() => configuration.groups[0]?.id ?? ("00000000-0000-4000-8000-000000000001" as UUID), [configuration.groups]);
  const [selectedId, setSelectedId] = useState<UUID>(firstId);
  const selected = configuration.groups.find((group) => group.id === selectedId) ?? configuration.groups[0];
  if (!selected) return <p>No managed groups.</p>;
  return <div className="groups-page"><h1 className="sr-only">Groups</h1>
    <GroupNavigator groups={configuration.groups} selectedId={selected.id} onSelect={setSelectedId} onAdd={() => void command({ kind: "manager-command", command: { kind: "createGroup", input: { name: "New group", color: "blue" } } })} onDelete={(id) => void command({ kind: "manager-command", command: { kind: "deleteGroup", groupId: id } })} />
    <GroupInspector group={selected} command={command} onNavigate={onNavigate} />
  </div>;
}
