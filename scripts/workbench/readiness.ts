export const WORKER_DISCOVERY_TIMEOUT_MS = 15_000;
export const MANAGER_QUERY_TIMEOUT_MS = 5_000;
export const MANAGER_RETRY_INTERVAL_MS = 250;

export type WorkbenchCodedPhase =
  | "argument"
  | "worker"
  | "manager-query"
  | "restart-termination"
  | "restart-wake"
  | "artifact";

export class WorkbenchCodedError extends Error {
  constructor(
    readonly code: "WORKBENCH_ARGUMENT" | "WORKBENCH_WORKER_TIMEOUT" | "WORKBENCH_MANAGER_TIMEOUT" | "WORKBENCH_ARTIFACT_LIMIT",
    message: string,
    readonly phase: WorkbenchCodedPhase
  ) {
    super(message);
    this.name = "WorkbenchCodedError";
  }
}

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
  const timeoutError = new WorkbenchCodedError(
    "WORKBENCH_MANAGER_TIMEOUT",
    "first manager query did not settle before the deadline",
    "manager-query"
  );

  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeoutError;
    try {
      const response = await raceRequest(input.request, remaining, timeoutError, now);
      return { response, settledAt: now() - startedAt };
    } catch (error) {
      if (error === timeoutError) throw error;
      if (!isReceivingEndStartupRace(error)) throw error;
      if (now() >= deadline) throw timeoutError;
      const delay = Math.min(retryIntervalMs, deadline - now());
      if (delay <= 0) throw timeoutError;
      await sleep(delay);
    }
  }
}

async function raceRequest(
  request: () => Promise<unknown>,
  remaining: number,
  timeoutError: WorkbenchCodedError,
  now: () => number
): Promise<unknown> {
  const pending = request();
  if (now !== Date.now) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), remaining);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
