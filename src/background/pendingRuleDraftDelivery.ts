import {
  clearPendingRuleDraft,
  readPendingRuleDraft,
  type PendingRuleDraft
} from "../controller/executeUserCommand";
import type { SessionRepository } from "../state/sessionRepository";

export type DeliveredPendingRuleDraft = Pick<
  PendingRuleDraft,
  "host" | "url" | "createdAt"
>;

export function createPendingRuleDraftDelivery(session: SessionRepository) {
  let tail: Promise<void> = Promise.resolve();

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(operation, operation);
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return {
    read(): Promise<DeliveredPendingRuleDraft | undefined> {
      return runExclusive(async () => {
        const draft = await readPendingRuleDraft(session);
        if (!draft) return undefined;
        return {
          host: draft.host,
          url: draft.url,
          createdAt: draft.createdAt
        };
      });
    },

    acknowledge(createdAt: number): Promise<boolean> {
      return runExclusive(async () => {
        const draft = await readPendingRuleDraft(session);
        if (!draft || draft.createdAt !== createdAt) return false;
        await clearPendingRuleDraft(session);
        return true;
      });
    },

    runExclusive
  };
}
