import type { ChromeAssociation } from "../domain/types";

export interface SessionRepository {
  loadAssociations(): Promise<readonly ChromeAssociation[]>;
  saveAssociations(associations: readonly ChromeAssociation[]): Promise<void>;
  loadRuntime(): Promise<Record<string, unknown>>;
  updateRuntime(patch: Record<string, unknown>): Promise<void>;
}

export interface SessionStoragePort {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export function createMemorySessionRepository(initial: readonly ChromeAssociation[] = []): SessionRepository {
  let value: Record<string, unknown> = { associations: [...initial] };
  return {
    async loadAssociations() {
      return (value.associations as ChromeAssociation[] | undefined) ?? [];
    },
    async saveAssociations(associations) {
      value = { ...value, associations: [...associations] };
    },
    async loadRuntime() {
      return { ...value };
    },
    async updateRuntime(patch) {
      value = { ...value, ...patch };
    }
  };
}

export function createChromeSessionRepository(storage: SessionStoragePort): SessionRepository {
  const key = "runtime:v1";
  let queue: Promise<unknown> = Promise.resolve();

  async function readState(): Promise<Record<string, unknown>> {
    const stored = await storage.get(key);
    const value = stored[key];
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async loadAssociations() {
      return serialized(async () =>
        (await readState()).associations as ChromeAssociation[] | undefined ?? []
      );
    },
    async saveAssociations(associations) {
      await serialized(async () => {
        const current = await readState();
        await storage.set({ [key]: { ...current, associations: [...associations] } });
      });
    },
    async loadRuntime() {
      return serialized(readState);
    },
    async updateRuntime(patch) {
      await serialized(async () => {
        const current = await readState();
        await storage.set({ [key]: { ...current, ...patch } });
      });
    }
  };
}
