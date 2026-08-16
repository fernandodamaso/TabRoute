import type {
  ManagerFailure,
  ManagerResponse,
  ManagerTransport
} from "./types";

export const MANAGER_STARTUP_QUERY_RETRY = {
  // A transport attempt may use the existing 5-second request timeout. Keep
  // the recovery window longer so a TIMEOUT can be followed by another read.
  deadlineMs: 15_000,
  intervalMs: 250
} as const;

const RETRYABLE_TRANSPORT_CODES = new Set([
  "NO_RESPONSE",
  "BACKGROUND_STARTUP_FAILED",
  "TIMEOUT"
]);

const RETRYABLE_RUNTIME_MESSAGES = [
  "receiving end does not exist",
  "could not establish connection",
  "message port closed",
  "background startup"
] as const;

export function isRetryableInitialManagerQueryFailure(
  response: ManagerResponse
): response is ManagerFailure {
  if (response.ok || response.error.kind !== "transport") return false;
  if (
    response.error.code !== undefined &&
    RETRYABLE_TRANSPORT_CODES.has(response.error.code)
  )
    return true;
  if (
    response.error.code !== "RUNTIME_ERROR" &&
    response.error.code !== "RUNTIME_LAST_ERROR"
  )
    return false;
  const message = response.error.message.toLowerCase();
  return RETRYABLE_RUNTIME_MESSAGES.some((fragment) =>
    message.includes(fragment)
  );
}

export async function requestInitialManagerQuery(
  transport: ManagerTransport,
  input: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    deadlineMs?: number;
    retryIntervalMs?: number;
    onRetry?: (failure: ManagerFailure, attempt: number) => void;
  } = {}
): Promise<ManagerResponse> {
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadlineMs = input.deadlineMs ?? MANAGER_STARTUP_QUERY_RETRY.deadlineMs;
  const retryIntervalMs =
    input.retryIntervalMs ?? MANAGER_STARTUP_QUERY_RETRY.intervalMs;
  const deadline = now() + Math.max(deadlineMs, 0);
  let attempt = 0;

  while (true) {
    attempt += 1;
    const response = await transport.request({ kind: "manager-query" });
    if (!isRetryableInitialManagerQueryFailure(response)) return response;

    const remaining = deadline - now();
    if (remaining <= 0) return response;

    input.onRetry?.(response, attempt);
    const delay = Math.min(Math.max(retryIntervalMs, 0), remaining);
    if (delay > 0) await sleep(delay);
  }
}
