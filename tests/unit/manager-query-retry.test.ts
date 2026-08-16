import { describe, expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import {
  MANAGER_STARTUP_QUERY_RETRY,
  isRetryableInitialManagerQueryFailure,
  requestInitialManagerQuery
} from "../../src/ui/manager/managerQueryRetry";
import type {
  ManagerMessage,
  ManagerResponse,
  ManagerViewMetadata
} from "../../src/ui/manager/types";

const view = {
  width: 520,
  height: 600,
  headerHeight: 52,
  navigationHeight: 42,
  defaultRoute: "groups",
  routes: ["groups", "rules", "activity", "settings"] as const
} satisfies ManagerViewMetadata;

const configuration = createDefaultConfiguration(
  () => "00000000-0000-4000-8000-000000000001"
);

function transportFailure(code: string, message = code): ManagerResponse {
  return {
    ok: false,
    error: { kind: "transport", code, message }
  };
}

describe("initial manager query recovery", () => {
  it("retries a transient read-only startup failure and converges", async () => {
    let clock = 0;
    const request = vi
      .fn<(message: ManagerMessage) => Promise<ManagerResponse>>()
      .mockResolvedValueOnce(transportFailure("NO_RESPONSE"))
      .mockResolvedValueOnce(transportFailure("BACKGROUND_STARTUP_FAILED"))
      .mockResolvedValueOnce({ ok: true, configuration, view });

    const result = await requestInitialManagerQuery(
      { request },
      {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        deadlineMs: 1_000,
        retryIntervalMs: 100
      }
    );

    expect(result).toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(3);
    for (const call of request.mock.calls) {
      expect(call[0]).toEqual({ kind: "manager-query" });
    }
  });

  it("does not retry non-transport failures", async () => {
    const response: ManagerResponse = {
      ok: false,
      error: {
        kind: "persistence",
        code: "READ_FAILED",
        message: "storage failed"
      }
    };
    const request = vi.fn(async () => response);

    const result = await requestInitialManagerQuery({ request });

    expect(result).toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops retrying at the configured deadline", async () => {
    let clock = 0;
    const request = vi.fn(async () => transportFailure("NO_RESPONSE"));

    const result = await requestInitialManagerQuery(
      { request },
      {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        deadlineMs: 200,
        retryIntervalMs: 100
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "transport", code: "NO_RESPONSE" }
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(clock).toBe(200);
  });

  it("allows a timeout attempt to be followed by startup retries", async () => {
    let clock = 0;
    const request = vi.fn(async () => {
      clock += 5_000;
      return transportFailure("TIMEOUT", "Manager request timed out");
    });

    const result = await requestInitialManagerQuery(
      { request },
      {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        }
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "transport", code: "TIMEOUT" }
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(MANAGER_STARTUP_QUERY_RETRY.deadlineMs).toBeGreaterThan(5_000);
  });

  it("does not classify offline or permanent runtime errors as startup-retryable", () => {
    const offline: ManagerResponse = {
      ok: false,
      error: { kind: "offline", code: "OFFLINE", message: "offline" }
    };
    const arbitrary = transportFailure("RUNTIME_ERROR", "permission denied");
    const permanentLastError = transportFailure(
      "RUNTIME_LAST_ERROR",
      "The extension context is invalidated"
    );
    const startup = transportFailure(
      "RUNTIME_ERROR",
      "Could not establish connection. Receiving end does not exist."
    );
    const startupLastError = transportFailure(
      "RUNTIME_LAST_ERROR",
      "Could not establish connection. Receiving end does not exist."
    );

    expect(isRetryableInitialManagerQueryFailure(offline)).toBe(false);
    expect(isRetryableInitialManagerQueryFailure(arbitrary)).toBe(false);
    expect(isRetryableInitialManagerQueryFailure(permanentLastError)).toBe(
      false
    );
    expect(isRetryableInitialManagerQueryFailure(startup)).toBe(true);
    expect(isRetryableInitialManagerQueryFailure(startupLastError)).toBe(true);
  });
});
