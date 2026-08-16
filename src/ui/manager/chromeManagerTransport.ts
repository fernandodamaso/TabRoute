import { validateConfiguration } from "../../domain/schemas";
import type {
  ManagerFailure,
  ManagerMessage,
  ManagerResponse,
  ManagerTransport,
  ManagerTransportRecord,
  ManagerViewFixture,
  ManagerViewMetadata
} from "./types";

class ChromeManagerTransportError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ChromeManagerTransportError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isView(value: unknown): value is ManagerViewMetadata {
  if (!isRecord(value)) return false;
  return (
    value.width === 520 &&
    value.height === 600 &&
    value.headerHeight === 52 &&
    value.navigationHeight === 42 &&
    value.defaultRoute === "groups" &&
    Array.isArray(value.routes) &&
    value.routes.every(
      (route) =>
        route === "groups" ||
        route === "rules" ||
        route === "activity" ||
        route === "settings"
    )
  );
}

function isViewFixture(value: unknown): value is ManagerViewFixture {
  if (!isRecord(value) || !isRecord(value.persistentTabsByGroup)) return false;
  return Object.values(value.persistentTabsByGroup).every((fixture) => {
    if (!isRecord(fixture) || !Array.isArray(fixture.tabs)) return false;
    const validState =
      fixture.state === "loading" ||
      fixture.state === "empty" ||
      fixture.state === "populated" ||
      fixture.state === "disabled" ||
      fixture.state === "error";
    return validState && fixture.tabs.every((tab) => typeof tab === "string");
  });
}

function isFailure(value: unknown): value is ManagerFailure {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error))
    return false;
  const kind = value.error.kind;
  const validKind =
    kind === "validation" ||
    kind === "reference" ||
    kind === "persistence" ||
    kind === "offline" ||
    kind === "transport";
  return (
    validKind &&
    typeof value.error.message === "string" &&
    (value.error.code === undefined || typeof value.error.code === "string") &&
    (value.error.field === undefined || typeof value.error.field === "string")
  );
}

function normalizeResponse(value: unknown): ManagerResponse | undefined {
  if (isFailure(value)) return value;
  if (!isRecord(value) || value.ok !== true || !isView(value.view))
    return undefined;
  if (value.viewFixture !== undefined && !isViewFixture(value.viewFixture))
    return undefined;
  try {
    const configuration = validateConfiguration(value.configuration);
    return {
      ok: true,
      configuration,
      view: value.view,
      ...(value.viewFixture === undefined
        ? {}
        : { viewFixture: value.viewFixture })
    };
  } catch {
    return undefined;
  }
}

function failure(
  kind: ManagerFailure["error"]["kind"],
  code: string,
  message: string
): ManagerFailure {
  return { ok: false, error: { kind, code, message } };
}

function classifyError(error: unknown): ManagerFailure {
  const message =
    error instanceof Error ? error.message : "Manager transport failed";
  const lower = message.toLowerCase();
  if (
    (typeof navigator !== "undefined" && navigator.onLine === false) ||
    lower.includes("offline")
  )
    return failure("offline", "OFFLINE", message);
  if (error instanceof ChromeManagerTransportError)
    return failure("transport", error.code, message);
  return failure("transport", "RUNTIME_ERROR", message);
}

function defaultSendMessage(message: ManagerMessage): Promise<unknown> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage)
    return Promise.reject(
      new ChromeManagerTransportError(
        "RUNTIME_UNAVAILABLE",
        "Chrome runtime messaging is unavailable"
      )
    );
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(
            new ChromeManagerTransportError(
              "RUNTIME_LAST_ERROR",
              lastError.message || "Chrome runtime messaging failed"
            )
          );
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ChromeManagerTransportError(
            "TIMEOUT",
            "Manager request timed out"
          )
        ),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function createChromeManagerTransport(
  input: {
    sendMessage?: (message: ManagerMessage) => Promise<unknown>;
    timeoutMs?: number;
    onRecord?: (record: ManagerTransportRecord) => void;
  } = {}
): ManagerTransport {
  const sendMessage = input.sendMessage ?? defaultSendMessage;
  const timeoutMs = input.timeoutMs ?? 5000;
  let sequence = 0;

  function emit(record: ManagerTransportRecord) {
    try {
      input.onRecord?.(record);
    } catch {
      /* recorders are observational */
    }
  }

  return {
    async request(message) {
      const requestSequence = ++sequence;
      const requestId = `manager-real-${requestSequence}`;
      const startedAt = Date.now();
      emit({
        recordType: "request",
        state: "pending",
        mode: "real",
        requestId,
        sequence: requestSequence,
        message,
        startedAt,
        latencyMs: 0
      });

      try {
        const raw = await withTimeout(sendMessage(message), timeoutMs);
        if (raw === undefined) {
          const result = failure(
            "transport",
            "NO_RESPONSE",
            "Manager runtime returned no response"
          );
          emit({
            recordType: "request",
            state: "rejected",
            mode: "real",
            requestId,
            sequence: requestSequence,
            message,
            startedAt,
            endedAt: Date.now(),
            latencyMs: Date.now() - startedAt,
            error: result.error
          });
          return result;
        }
        const response = normalizeResponse(raw);
        if (!response) {
          const result = failure(
            "transport",
            "INVALID_RESPONSE",
            "Manager runtime returned an invalid response"
          );
          const endedAt = Date.now();
          emit({
            recordType: "request",
            state: "rejected",
            mode: "real",
            requestId,
            sequence: requestSequence,
            message,
            startedAt,
            endedAt,
            latencyMs: endedAt - startedAt,
            error: result.error
          });
          return result;
        }
        const endedAt = Date.now();
        emit({
          recordType: "request",
          state: "resolved",
          mode: "real",
          requestId,
          sequence: requestSequence,
          message,
          startedAt,
          endedAt,
          latencyMs: endedAt - startedAt,
          response
        });
        return response;
      } catch (error) {
        const result = classifyError(error);
        const endedAt = Date.now();
        emit({
          recordType: "request",
          state: "rejected",
          mode: "real",
          requestId,
          sequence: requestSequence,
          message,
          startedAt,
          endedAt,
          latencyMs: endedAt - startedAt,
          error: result.error
        });
        return result;
      }
    }
  };
}
