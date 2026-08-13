export type MutationErrorClass =
  | "transient-drag"
  | "gone"
  | "permission"
  | "invalid"
  | "unknown";

export function classifyMutationError(error: unknown): MutationErrorClass {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lower = message.toLowerCase();
  if (lower.includes("tabs cannot be edited right now")) return "transient-drag";
  if (lower.includes("permission") || lower.includes("not allowed"))
    return "permission";
  if (lower.includes("invalid") || lower.includes("no tab"))
    return "invalid";
  return "unknown";
}

const RETRY_DELAYS_MS = [50, 150] as const;

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  refresh: () => Promise<unknown>,
  delay: (ms: number) => Promise<void>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const kind = classifyMutationError(error);
      if (kind !== "transient-drag" || attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      await refresh();
      await delay(RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastError;
}
