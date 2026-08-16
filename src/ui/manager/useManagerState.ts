import { useCallback, useEffect, useRef, useState } from "react";
import { createDefaultConfiguration } from "../../domain/defaults";
import type { Configuration } from "../../domain/types";
import { createChromeManagerTransport } from "./chromeManagerTransport";
import { requestInitialManagerQuery } from "./managerQueryRetry";
import type {
  ManagerCommandPayload,
  ManagerFailure,
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
      message:
        error instanceof Error ? error.message : "Manager transport failed"
    }
  };
}

function managerNotReadyFailure(): ManagerResponse {
  return {
    ok: false,
    error: {
      kind: "transport",
      code: "MANAGER_NOT_READY",
      message: "Manager configuration has not loaded yet"
    }
  };
}

export function useManagerState(
  transport: ManagerTransport = browserManagerTransport
) {
  const [configuration, setConfiguration] =
    useState<Configuration>(previewConfiguration);
  const [viewFixture, setViewFixture] = useState<ManagerViewFixture>();
  const [status, setStatus] = useState<
    "loading" | "reconnecting" | "ready" | "error"
  >("loading");
  const [lastError, setLastError] = useState<ManagerFailure["error"]>();
  const [hasConfirmedConfiguration, setHasConfirmedConfiguration] = useState(
    transport.allowPreview === true
  );
  const confirmedConfigurationRef = useRef(transport.allowPreview === true);
  const firstQueryRef = useRef(true);

  const query = useCallback(async (): Promise<ManagerResponse> => {
    const isFirstQuery = firstQueryRef.current;
    firstQueryRef.current = false;
    setStatus(
      confirmedConfigurationRef.current &&
        !(isFirstQuery && transport.allowPreview === true)
        ? "reconnecting"
        : "loading"
    );
    try {
      const result = await requestInitialManagerQuery(transport, {
        onRetry: () => setStatus("reconnecting")
      });
      if (result.ok) {
        confirmedConfigurationRef.current = true;
        setHasConfirmedConfiguration(true);
        setConfiguration(result.configuration);
        setViewFixture(result.viewFixture);
        setLastError(undefined);
        setStatus("ready");
      } else {
        setLastError(result.error);
        setStatus("error");
      }
      return result;
    } catch (error) {
      const result = thrownTransportFailure(error);
      if (!result.ok) setLastError(result.error);
      setStatus("error");
      return result;
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
        limit: 500
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

  const queryDiagnostics = useCallback(async (): Promise<ManagerResponse> => {
    try {
      const result = await transport.request({ kind: "diagnostics-query" });
      if (result.ok) {
        setConfiguration(result.configuration);
        if (result.viewFixture) setViewFixture(result.viewFixture);
      }
      return result;
    } catch (error) {
      return thrownTransportFailure(error);
    }
  }, [transport]);

  useEffect(() => {
    void query();
  }, [query]);

  const command = useCallback(
    async (message: ManagerMessage): Promise<ManagerResponse> => {
      if (!confirmedConfigurationRef.current) return managerNotReadyFailure();
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
    },
    [transport]
  );

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
    lastError,
    hasConfirmedConfiguration,
    query,
    queryActivity,
    querySnapshots,
    queryDiagnostics,
    command,
    runCommand
  };
}
