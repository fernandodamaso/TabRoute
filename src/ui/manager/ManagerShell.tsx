import { useEffect, useRef } from "react";
import type { ManagerRoute, SettingsPanel } from "./types";

const navigation: Array<{ route: ManagerRoute; label: string }> = [
  { route: "groups", label: "Groups" }, { route: "rules", label: "Rules" },
  { route: "activity", label: "Activity" }, { route: "settings", label: "Settings" }
];

export function ManagerShell({ route, onRouteChange, children, status, settingsPanel }: {
  route: ManagerRoute;
  onRouteChange: (route: ManagerRoute) => void;
  children: React.ReactNode;
  status?: string;
  settingsPanel?: SettingsPanel;
}) {
  const pageRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    document.documentElement.setAttribute("data-manager-viewport", "520x600");
    if (firstRender.current) firstRender.current = false;
    else pageRef.current?.focus();
    document.title = `TabRoute — ${route[0]!.toUpperCase()}${route.slice(1)}`;
  }, [route]);
  return <div className="manager-shell">
    <header className="manager-header">
      <div><p className="manager-eyebrow">TABROUTE</p><strong>Tab manager</strong></div>
      <span className="manager-status" role="status">{status ?? "Ready"}</span>
    </header>
    <nav className="manager-primary-nav" aria-label="Primary">
      {navigation.map(({ route: destination, label }) => <button key={destination} type="button" data-route-focus={destination} aria-current={route === destination ? "page" : undefined} onClick={() => onRouteChange(destination)}>{label}</button>)}
    </nav>
    <main ref={pageRef} className={`manager-page-scroll route-${route}${route === "settings" && settingsPanel === "snapshots" ? " route-settings-snapshots" : ""}`} tabIndex={-1} data-route-focus={route} aria-label={`${route} page`}>{children}</main>
  </div>;
}
