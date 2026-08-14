import { useEffect, useMemo, useState } from "react";
import { ManagerApp } from "../ui/manager/ManagerApp";
import { createChromeManagerTransport } from "../ui/manager/chromeManagerTransport";
import type { ManagerTransportRecord } from "../ui/manager/types";
import { createFixtureManagerTransport } from "./fixtureManagerTransport";
import { WorkbenchHost } from "./WorkbenchHost";
import { parseWorkbenchSearch } from "./url";

export function WorkbenchOptionsApp() {
  const [state, setState] = useState(() =>
    parseWorkbenchSearch(window.location.search)
  );
  const [revision, setRevision] = useState(0);
  const [realRecords, setRealRecords] = useState<ManagerTransportRecord[]>([]);
  const fixture = useMemo(
    () =>
      createFixtureManagerTransport({
        scenarioId: state.scenarioId,
        latencyMs: state.latencyMs,
        failure: state.failure
      }),
    [state.scenarioId]
  );
  const real = useMemo(
    () =>
      createChromeManagerTransport({
        onRecord: (record) => setRealRecords((current) => [...current, record])
      }),
    []
  );
  const [fixtureTick, setFixtureTick] = useState(0);

  useEffect(() => {
    fixture.controls.setLatency(state.latencyMs);
    fixture.controls.setFailure(state.failure);
  }, [fixture, state.failure, state.latencyMs]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setFixtureTick((value) => value + 1),
      10
    );
    return () => window.clearInterval(timer);
  }, []);

  const records = [...fixture.controls.commandLog(), ...realRecords];
  void fixtureTick;

  function change(next: typeof state): void {
    setState(next);
    const deepLinkChanged =
      JSON.stringify(next.deepLink) !== JSON.stringify(state.deepLink);
    const requiresRemount =
      next.mode !== state.mode ||
      next.scenarioId !== state.scenarioId ||
      deepLinkChanged ||
      (next.route === state.route &&
        next.latencyMs === state.latencyMs &&
        JSON.stringify(next.failure) === JSON.stringify(state.failure));
    if (requiresRemount) setRevision((value) => value + 1);
  }

  return (
    <WorkbenchHost
      key={`${state.mode}:${state.scenarioId}:${revision}`}
      state={state}
      fixture={state.mode === "fixture" ? fixture : undefined}
      real={real}
      records={records}
      onStateChange={change}
      onFixtureReset={() => setRevision((value) => value + 1)}
    >
      <ManagerApp
        key={`${state.mode}:${state.scenarioId}:${revision}`}
        transport={state.mode === "fixture" ? fixture.transport : real}
        initialRoute={state.route}
        initialDeepLink={state.deepLink}
      />
    </WorkbenchHost>
  );
}
