import { useEffect, useRef, useState } from "react";

import type { UUID } from "../../domain/types";

import type {
  ManagerAppProps,
  ManagerDeepLink,
  ManagerRoute,
  ManagerViewFixture
} from "./types";

import { ManagerShell } from "./ManagerShell";

import { useManagerState } from "./useManagerState";

import { GroupsPage } from "./pages/GroupsPage";

import { RulesPage } from "./pages/RulesPage";

import { ActivityPage } from "./pages/ActivityPage";

import { SnapshotsPage } from "./pages/SnapshotsPage";

import { SettingsPage } from "./pages/SettingsPage";

import { DiagnosticsPage } from "./pages/DiagnosticsPage";

import type { SettingsPanel } from "./types";

import "./manager.css";

const ROUTES: readonly ManagerRoute[] = [
  "groups",
  "rules",
  "activity",
  "settings"
];

function initialRuleEditor(
  deepLink: ManagerDeepLink | undefined
): UUID | "new" | undefined {
  if (deepLink === "new-rule") return "new";

  return typeof deepLink === "object" && deepLink.kind === "edit-rule"
    ? deepLink.ruleId
    : undefined;
}

function initialDeleteRule(
  deepLink: ManagerDeepLink | undefined
): UUID | undefined {
  return typeof deepLink === "object" && deepLink.kind === "confirm-delete"
    ? deepLink.ruleId
    : undefined;
}

function settingsPanelFromDeepLink(
  deepLink: ManagerDeepLink | undefined
): SettingsPanel {
  if (deepLink === "snapshots") return "snapshots";

  if (deepLink === "diagnostics") return "diagnostics";

  return "root";
}

function parseLocationHash(): {
  route: ManagerRoute;
  settingsPanel: SettingsPanel;
} {
  const hash =
    typeof window === "undefined" ? "" : window.location.hash.slice(1);

  if (hash === "settings" || hash === "settings/") {
    return { route: "settings", settingsPanel: "root" };
  }

  if (hash === "settings/snapshots") {
    return { route: "settings", settingsPanel: "snapshots" };
  }

  if (hash === "settings/diagnostics") {
    return { route: "settings", settingsPanel: "diagnostics" };
  }

  if (hash === "snapshots" || hash === "diagnostics") {
    return { route: "groups", settingsPanel: "root" };
  }

  if (ROUTES.includes(hash as ManagerRoute)) {
    return { route: hash as ManagerRoute, settingsPanel: "root" };
  }

  return { route: "groups", settingsPanel: "root" };
}

function settingsHash(panel: SettingsPanel): string {
  if (panel === "snapshots") return "#settings/snapshots";

  if (panel === "diagnostics") return "#settings/diagnostics";

  return "#settings";
}

export function ManagerApp({
  surface: _surface,

  transport,

  initialRoute,

  initialDeepLink = "none"
}: ManagerAppProps & { viewFixture?: ManagerViewFixture }) {
  const initialLocation = parseLocationHash();

  const [route, setRoute] = useState<ManagerRoute>(
    () => initialRoute ?? initialLocation.route
  );

  const [editingRuleId, setEditingRuleId] = useState<
    UUID | "new" | undefined
  >();

  const [confirmDeleteRuleId, setConfirmDeleteRuleId] = useState<UUID>();

  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>(() => {
    if (initialDeepLink === "snapshots" || initialDeepLink === "diagnostics") {
      return initialDeepLink;
    }
    if (initialRoute === "settings" || initialLocation.route === "settings") {
      return initialLocation.settingsPanel;
    }
    return "root";
  });

  const initialDeepLinkApplied = useRef(false);

  const lastInitialRoute = useRef(initialRoute);

  const state = useManagerState(transport);

  useEffect(() => {
    if (route !== "activity" || state.status !== "ready") return;

    void state.queryActivity();
  }, [route, state.status, state.queryActivity]);

  useEffect(() => {
    if (
      route !== "settings" ||
      settingsPanel !== "snapshots" ||
      state.status !== "ready"
    )
      return;

    void state.querySnapshots();
  }, [route, settingsPanel, state.status, state.querySnapshots]);

  useEffect(() => {
    if (
      route !== "settings" ||
      settingsPanel !== "diagnostics" ||
      state.status !== "ready"
    )
      return;

    void state.queryDiagnostics();
  }, [route, settingsPanel, state.status, state.queryDiagnostics]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const nextHash =
      route === "settings" ? settingsHash(settingsPanel) : `#${route}`;

    if (window.location.hash !== nextHash) window.location.hash = nextHash;
  }, [route, settingsPanel]);

  useEffect(() => {
    if (initialDeepLinkApplied.current || state.status !== "ready") return;

    initialDeepLinkApplied.current = true;

    setEditingRuleId(initialRuleEditor(initialDeepLink));

    setConfirmDeleteRuleId(initialDeleteRule(initialDeepLink));

    if (
      route === "settings" &&
      (initialDeepLink === "snapshots" || initialDeepLink === "diagnostics")
    ) {
      setSettingsPanel(settingsPanelFromDeepLink(initialDeepLink));
    }
  }, [initialDeepLink, route, state.status]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const draft = state.viewFixture?.pendingRuleDraft;
    if (!draft) return;
    setRoute("rules");
    setEditingRuleId("new");
  }, [state.status, state.viewFixture?.pendingRuleDraft]);

  useEffect(() => {
    if (initialRoute === undefined || initialRoute === lastInitialRoute.current)
      return;

    lastInitialRoute.current = initialRoute;

    setRoute(initialRoute);
  }, [initialRoute, route]);

  const openSettingsPanel = (panel: SettingsPanel) => {
    setRoute("settings");

    setSettingsPanel(panel);
  };

  const connectionStatus =
    state.status === "loading"
      ? "Loading"
      : state.status === "reconnecting"
        ? "Reconnecting"
        : state.status === "error"
          ? state.hasConfirmedConfiguration
            ? "Connection issue"
            : "Unavailable"
          : "Ready";

  return (
    <ManagerShell
      route={route}

      settingsPanel={route === "settings" ? settingsPanel : undefined}

      onRouteChange={(nextRoute) => {
        setRoute(nextRoute);

        if (nextRoute !== "settings") setSettingsPanel("root");
      }}

      status={connectionStatus}
    >
      {!state.hasConfirmedConfiguration ? (
        <section className="manager-readiness" aria-label="Manager connection">
          <h1>
            {state.status === "error"
              ? "Manager unavailable"
              : "Connecting to TabRoute"}
          </h1>
          <p>
            {state.status === "error"
              ? (state.lastError?.message ??
                "The background service is not ready yet.")
              : state.status === "reconnecting"
                ? "The background service is starting. Retrying the read-only manager query…"
                : "Loading your saved TabRoute configuration…"}
          </p>
          {state.status === "error" ? (
            <button type="button" onClick={() => void state.query()}>
              Retry connection
            </button>
          ) : null}
        </section>
      ) : route === "groups" ? (
        <GroupsPage
          configuration={state.configuration}

          command={state.command}

          viewFixture={state.viewFixture}

          onNavigate={(destination) => setRoute(destination)}
        />
      ) : route === "rules" ? (
        <RulesPage
          configuration={state.configuration}

          command={state.command}

          editingRuleId={editingRuleId}

          initialConfirmDeleteRuleId={confirmDeleteRuleId}

          onInitialConfirmDeleteConsumed={() =>
            setConfirmDeleteRuleId(undefined)
          }

          onEdit={(id) => setEditingRuleId(id)}

          onCreate={() => setEditingRuleId("new")}

          onCancel={() => setEditingRuleId(undefined)}

          onSaved={() => setEditingRuleId(undefined)}

          prefill={state.viewFixture?.pendingRuleDraft}
        />
      ) : route === "activity" ? (
        <ActivityPage
          activity={state.viewFixture?.activity ?? []}

          availableUndo={state.viewFixture?.availableUndo}

          command={async (payload) => {
            await state.runCommand(payload);
          }}
        />
      ) : route === "settings" ? (
        settingsPanel === "snapshots" ? (
          <SnapshotsPage
            snapshots={state.viewFixture?.snapshots ?? []}

            groups={state.configuration.groups}

            command={async (payload) => {
              const result = await state.runCommand(payload);
              await state.querySnapshots();
              return result;
            }}

            onBack={() => setSettingsPanel("root")}
          />
        ) : settingsPanel === "diagnostics" ? (
          <DiagnosticsPage
            diagnostics={
              state.viewFixture?.diagnostics ?? {
                storage: {
                  syncBytes: 0,

                  syncQuotaBytes: 102400,

                  syncLargestItemBytes: 0,

                  syncQuotaBytesPerItem: 8192,

                  syncItemCount: 0,

                  syncMaxItems: 512,

                  localBytes: 0,

                  localSoftBudgetBytes: 9437184,

                  localQuotaBytes: 10485760,

                  sessionBytes: 0,

                  sessionQuotaBytes: 10485760
                },

                warnings: []
              }
            }

            command={async (payload) => {
              const result = await state.runCommand(payload);
              if (
                payload.kind === "exportActivityLog" &&
                result.ok &&
                result.viewFixture?.activityLogExport
              ) {
                const blob = new Blob([result.viewFixture.activityLogExport], {
                  type: "application/json"
                });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "tabroute-activity.json";
                anchor.click();
                URL.revokeObjectURL(url);
              }
              await state.queryDiagnostics();
            }}

            onBack={() => setSettingsPanel("root")}
          />
        ) : (
          <SettingsPage
            configuration={state.configuration}

            command={(payload) => state.runCommand(payload)}

            onOpenSnapshots={() => openSettingsPanel("snapshots")}

            onOpenDiagnostics={() => openSettingsPanel("diagnostics")}
          />
        )
      ) : null}
    </ManagerShell>
  );
}
