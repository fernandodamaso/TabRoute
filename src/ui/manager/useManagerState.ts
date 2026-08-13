import { useCallback, useEffect, useState } from "react";
import { createDefaultConfiguration } from "../../domain/defaults";
import type { Configuration } from "../../domain/types";
import { createChromeManagerTransport } from "./chromeManagerTransport";
import type {
  ManagerCommandPayload,
  ManagerMessage,
  ManagerResponse,
  ManagerTransport,
  ManagerViewFixture
} from "./types";

const previewConfiguration = createDefaultConfiguration(
  () => "00000000-0000-4000-8000-000000000001"
);

export const browserManagerTransport = createChromeManagerTransport();

function thrownTransportFailure(error: unknown): ManagerResponse {
  return {
    ok: false,
    error: {
      kind: "transport",
      code: "UNEXPECTED_TRANSPORT_THROW",
      message: error instanceof Error ? error.message : "Manager transport failed"
    }
  };
}

export function useManagerState(transport: ManagerTransport = browserManagerTransport) {
  const [configuration, setConfiguration] = useState<Configuration>(previewConfiguration);
  const [viewFixture, setViewFixture] = useState<ManagerViewFixture>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const query = useCallback(async (): Promise<ManagerResponse> => {
    try {
      const result = await transport.request({ kind: "manager-query" });
      if (result.ok) {
        setConfiguration(result.configuration);
        if (result.viewFixture) setViewFixture(result.viewFixture);
        setStatus("ready");
      } else {
        setStatus("error");
      }
      return result;
    } catch (error) {
      setStatus("error");
      return thrownTransportFailure(error);
    }
  }, [transport]);

  const querySnapshots = useCallback(async (): Promise<ManagerResponse> => {
    try {
      const result = await transport.request({ kind: "snapshots-query" });
      if (result.ok) {
        setConfiguration(result.configuration);
        if (result.viewFixture) setViewFixture(result.viewFixture);
      }
      return result;
    } catch (error) {
      return thrownTransportFailure(error);
    }
  }, [transport]);

  const queryActivity = useCallback(async (): Promise<ManagerResponse> => {
    try {
      const result = await transport.request({
        kind: "activity-query",
        limit: 50
      });
      if (result.ok) {
        setConfiguration(result.configuration);
        if (result.viewFixture) setViewFixture(result.viewFixture);
      }
      return result;
    } catch (error) {
      return thrownTransportFailure(error);
    }
  }, [transport]);

  useEffect(() => { void query(); }, [query]);

  const command = useCallback(async (message: ManagerMessage): Promise<ManagerResponse> => {
    try {
      const result = await transport.request(message);
      if (result.ok) {
        setConfiguration(result.configuration);
        if (result.viewFixture) setViewFixture(result.viewFixture);
      }
      return result;
    } catch (error) {
      return thrownTransportFailure(error);
    }
  }, [transport]);

  const runCommand = useCallback(
    async (payload: ManagerCommandPayload): Promise<ManagerResponse> =>
      command({ kind: "manager-command", command: payload }),
    [command]
  );

  return {
    configuration,
    setConfiguration,
    viewFixture,
    status,
    query,
    queryActivity,
    querySnapshots,
    command,
    runCommand
  };
}
