import type { ChromeAssociation, RuntimeAssociations } from "../domain/types";

export interface SessionRepository {
  loadAssociations(): Promise<readonly ChromeAssociation[]>;
  saveAssociations(associations: readonly ChromeAssociation[]): Promise<void>;
}

export function createMemorySessionRepository(initial: readonly ChromeAssociation[] = []): SessionRepository {
  let value = [...initial];
  return {
    async loadAssociations() { return value; },
    async saveAssociations(associations) { value = [...associations]; }
  };
}

export function createChromeSessionRepository(storage: Pick<chrome.storage.StorageArea, "get" | "set">): SessionRepository {
  const key = "runtime:v1";
  return {
    async loadAssociations() {
      const stored = await storage.get(key);
      return ((stored[key] as RuntimeAssociations | undefined)?.associations ?? []);
    },
    async saveAssociations(associations) {
      await storage.set({ [key]: { associations: [...associations] } satisfies RuntimeAssociations });
    }
  };
}
