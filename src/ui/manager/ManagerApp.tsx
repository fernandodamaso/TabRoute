import { useState } from "react";
import type { UUID } from "../../domain/types";
import type { ManagerRoute } from "./types";
import { ManagerShell } from "./ManagerShell";
import { useManagerState, type ManagerTransport } from "./useManagerState";
import { GroupsPage } from "./pages/GroupsPage";
import { RulesPage } from "./pages/RulesPage";
import "./manager.css";

export function ManagerApp({ surface: _surface, transport }: { surface?: "popup" | "options"; transport?: ManagerTransport }) {
  const [route, setRoute] = useState<ManagerRoute>(() => {
    const value = typeof window === "undefined" ? "" : window.location.hash.slice(1);
    return ["groups", "rules", "activity", "settings"].includes(value) ? value as ManagerRoute : "groups";
  });
  const [editingRuleId, setEditingRuleId] = useState<UUID | "new">();
  const state = useManagerState(transport);
  const title = `${route[0]!.toUpperCase()}${route.slice(1)}`;
  return <ManagerShell route={route} onRouteChange={setRoute} status={state.status === "error" ? "Offline preview" : state.status === "loading" ? "Loading" : "Ready"}>
    {route === "groups" ? <GroupsPage configuration={state.configuration} command={state.command} onNavigate={(destination) => setRoute(destination)} /> : route === "rules" ? <RulesPage configuration={state.configuration} command={state.command} editingRuleId={editingRuleId} onEdit={(id) => setEditingRuleId(id)} onCreate={() => setEditingRuleId("new")} onCancel={() => setEditingRuleId(undefined)} onSaved={() => setEditingRuleId(undefined)} /> : <><h1 data-page-heading="true">{title}</h1><section aria-label={`${title} content`} className="manager-page-content"><p className="manager-lede">{`${title} is ready for this manager.`}</p></section></>}
  </ManagerShell>;
}
