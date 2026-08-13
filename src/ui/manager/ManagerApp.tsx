import { useEffect, useRef, useState } from "react";
import type { UUID } from "../../domain/types";
import type { ManagerAppProps, ManagerDeepLink, ManagerRoute, ManagerViewFixture } from "./types";
import { ManagerShell } from "./ManagerShell";
import { useManagerState } from "./useManagerState";
import { GroupsPage } from "./pages/GroupsPage";
import { RulesPage } from "./pages/RulesPage";
import { ActivityPage } from "./pages/ActivityPage";
import "./manager.css";

function initialRuleEditor(deepLink: ManagerDeepLink | undefined): UUID | "new" | undefined {
  if (deepLink === "new-rule") return "new";
  return typeof deepLink === "object" && deepLink.kind === "edit-rule"
    ? deepLink.ruleId
    : undefined;
}

function initialDeleteRule(deepLink: ManagerDeepLink | undefined): UUID | undefined {
  return typeof deepLink === "object" && deepLink.kind === "confirm-delete"
    ? deepLink.ruleId
    : undefined;
}

export function ManagerApp({
  surface: _surface,
  transport,
  initialRoute,
  initialDeepLink = "none"
}: ManagerAppProps & { viewFixture?: ManagerViewFixture }) {
  const [route, setRoute] = useState<ManagerRoute>(() => {
    if (initialRoute) return initialRoute;
    const value = typeof window === "undefined" ? "" : window.location.hash.slice(1);
    return ["groups", "rules", "activity", "settings"].includes(value)
      ? value as ManagerRoute
      : "groups";
  });
  const [editingRuleId, setEditingRuleId] = useState<UUID | "new" | undefined>();
  const [confirmDeleteRuleId, setConfirmDeleteRuleId] = useState<UUID>();
  const initialDeepLinkApplied = useRef(false);
  const lastInitialRoute = useRef(initialRoute);
  const state = useManagerState(transport);
  const title = `${route[0]!.toUpperCase()}${route.slice(1)}`;

  useEffect(() => {
    if (initialDeepLinkApplied.current || state.status !== "ready") return;
    initialDeepLinkApplied.current = true;
    setEditingRuleId(initialRuleEditor(initialDeepLink));
    setConfirmDeleteRuleId(initialDeleteRule(initialDeepLink));
  }, [initialDeepLink, state.status]);

  useEffect(() => {
    if (initialRoute === undefined || initialRoute === lastInitialRoute.current) return;
    lastInitialRoute.current = initialRoute;
    setRoute(initialRoute);
  }, [initialRoute, route]);

  return <ManagerShell
    route={route}
    onRouteChange={setRoute}
    status={state.status === "error" ? "Offline preview" : state.status === "loading" ? "Loading" : "Ready"}
  >
    {route === "groups"
      ? <GroupsPage
          configuration={state.configuration}
          command={state.command}
          viewFixture={state.viewFixture}
          onNavigate={(destination) => setRoute(destination)}
        />
      : route === "rules"
        ? <RulesPage
            configuration={state.configuration}
            command={state.command}
            editingRuleId={editingRuleId}
            initialConfirmDeleteRuleId={confirmDeleteRuleId}
            onInitialConfirmDeleteConsumed={() => setConfirmDeleteRuleId(undefined)}
            onEdit={(id) => setEditingRuleId(id)}
            onCreate={() => setEditingRuleId("new")}
            onCancel={() => setEditingRuleId(undefined)}
            onSaved={() => setEditingRuleId(undefined)}
          />
        : route === "activity"
          ? <ActivityPage
              activity={state.viewFixture?.activity ?? []}
              availableUndo={state.viewFixture?.availableUndo}
              command={state.command}
            />
          : <>
            <h1 data-page-heading="true">{title}</h1>
            <section aria-label={`${title} content`} className="manager-page-content">
              <p className="manager-lede">{`${title} is ready for this manager.`}</p>
            </section>
          </>}
  </ManagerShell>;
}
