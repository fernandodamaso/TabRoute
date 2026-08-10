import { useCallback, useEffect, useState } from "react";
import { createDefaultConfiguration } from "../../domain/defaults";
import type { Configuration } from "../../domain/types";
import type { ManagerMessage, ManagerResponse } from "./types";

export type ManagerTransport = (message: ManagerMessage) => Promise<ManagerResponse>;
const previewConfiguration = createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001");

export function browserManagerTransport(message: ManagerMessage): Promise<ManagerResponse> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage)
    return Promise.resolve({ ok: true, configuration: previewConfiguration, view: { width: 520, height: 600, headerHeight: 52, navigationHeight: 42, defaultRoute: "groups", routes: ["groups", "rules", "activity", "settings"] } });
  return chrome.runtime.sendMessage(message) as Promise<ManagerResponse>;
}

export function useManagerState(transport: ManagerTransport = browserManagerTransport) {
  const [configuration, setConfiguration] = useState<Configuration>(previewConfiguration);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const query = useCallback(async () => {
    try {
      const result = await transport({ kind: "manager-query" });
      if (result.ok) { setConfiguration(result.configuration); setStatus("ready"); }
      else setStatus("error");
      return result;
    } catch { setStatus("error"); return undefined; }
  }, [transport]);
  useEffect(() => { void query(); }, [query]);
  const command = useCallback(async (message: ManagerMessage) => {
    const result = await transport(message);
    if (result.ok) setConfiguration(result.configuration);
    return result;
  }, [transport]);
  return { configuration, setConfiguration, status, query, command };
}
