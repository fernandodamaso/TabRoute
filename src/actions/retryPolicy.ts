const RETRY_DELAYS_MS = [50, 150] as const;

export type MutationErrorClass =
  "transient-drag" | "gone" | "permission" | "invalid" | "unknown";

export function classifyMutationError(error: unknown): MutationErrorClass {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lower = message.toLowerCase();
  if (lower.includes("tabs cannot be edited right now"))
    return "transient-drag";
  if (lower.includes("permission") || lower.includes("not allowed"))
    return "permission";
  if (lower.includes("invalid")) return "invalid";
  if (lower.includes("no tab with id")) return "gone";
  return "unknown";
}

export type RetryAbortReason = "gone" | "contradiction" | "satisfied";

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  refresh: () => Promise<unknown>,
  delay: (ms: number) => Promise<void>,
  shouldAbort?: (refreshed: unknown) => RetryAbortReason | undefined,
  onRetry?: (attempt: number) => void,
  onRecovered?: () => T
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const kind = classifyMutationError(error);
      if (kind !== "transient-drag" && kind !== "gone") throw error;
      if (attempt >= RETRY_DELAYS_MS.length && kind !== "gone") throw error;
      const refreshed = await refresh();
      const abort = shouldAbort?.(refreshed);
      if (abort === "satisfied") {
        if (!onRecovered)
          throw new Error("Action Engine recovery result unavailable");
        return onRecovered();
      }
      if (kind === "gone") throw error;
      if (abort) {
        throw new Error(
          abort === "gone"
            ? "No tab with id"
            : "Action Engine postcondition contradicted"
        );
      }
      onRetry?.(attempt + 1);
      await delay(RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastError;
}
