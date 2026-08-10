import type { Configuration } from "../domain/types";
import type {
  ConfigurationRepository,
  SyncChangeResult
} from "./configurationRepository";

export interface ConfigurationSyncApplyCallbacks {
  replaceConfiguration(configuration: Configuration): Promise<void>;
  refreshMenus(): Promise<void>;
  refreshAlarms(): Promise<void>;
  refreshViews(): Promise<void>;
}

export function createConfigurationSyncCoordinator(input: {
  repository: Pick<ConfigurationRepository, "applySyncChange">;
  callbacks: ConfigurationSyncApplyCallbacks;
}) {
  return {
    async applySyncChange(
      changedKeys: readonly string[] = []
    ): Promise<SyncChangeResult> {
      const result = await input.repository.applySyncChange(changedKeys);
      if (result.kind !== "applied") return result;
      await Promise.all([
        input.callbacks.replaceConfiguration(result.configuration),
        input.callbacks.refreshMenus(),
        input.callbacks.refreshAlarms(),
        input.callbacks.refreshViews()
      ]);
      return result;
    }
  };
}
