import type { Configuration } from "../domain/types";
import { createDefaultConfiguration } from "../domain/defaults";
import { validateConfiguration } from "../domain/schemas";

const configurationKey = "config:v1";

export interface ConfigurationRepository {
  loadOrCreate(): Promise<Configuration>;
  save(configuration: Configuration): Promise<void>;
}

interface ConfigurationStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export function createConfigurationRepository(input: {
  storage: ConfigurationStorage;
  createDefault?: () => Configuration;
}): ConfigurationRepository {
  const createDefault =
    input.createDefault ?? (() => createDefaultConfiguration());
  return {
    async loadOrCreate() {
      const stored = await input.storage.get(configurationKey);
      const existing = stored[configurationKey];
      if (existing !== undefined) {
        try {
          const normalized = validateConfiguration(existing);
          if (JSON.stringify(normalized) !== JSON.stringify(existing))
            await input.storage.set({ [configurationKey]: normalized });
          return normalized;
        } catch {
          /* replace invalid bootstrap state */
        }
      }
      const configuration = validateConfiguration(createDefault());
      await input.storage.set({ [configurationKey]: configuration });
      return configuration;
    },
    async save(configuration) {
      await input.storage.set({
        [configurationKey]: validateConfiguration(configuration)
      });
    }
  };
}
