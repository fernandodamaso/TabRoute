export const WORKER_DISCOVERY_TIMEOUT_MS = 15_000;
export const MANAGER_QUERY_TIMEOUT_MS = 5_000;
export const MANAGER_RETRY_INTERVAL_MS = 250;

export function isReceivingEndStartupRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("receiving end does not exist");
}

export async function settleManagerQuery(input: {
  request: () => Promise<unknown>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): Promise<{ response: unknown; settledAt: number }> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = input.timeoutMs ?? MANAGER_QUERY_TIMEOUT_MS;
  const retryIntervalMs = input.retryIntervalMs ?? MANAGER_RETRY_INTERVAL_MS;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;

  while (true) {
    try {
      const response = await input.request();
      return { response, settledAt: now() - startedAt };
    } catch (error) {
      if (!isReceivingEndStartupRace(error) || now() >= deadline) throw error;
      const remaining = deadline - now();
      const delay = Math.min(retryIntervalMs, remaining);
      if (delay <= 0) throw error;
      await sleep(delay);
    }
  }
}
