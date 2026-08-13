import type { Configuration } from "../domain/types";
import type {
  ConfigurationRepository,
  SyncChangeResult
} from "./configurationRepository";
import type { LocalRepository } from "./localRepository";
import {
  recordSyncRevisionActivity,
  type SyncRevisionActivityResult
} from "../activity/activityRepository";

export const CONFIGURATION_SYNC_RETRY_ALARM = "config:v1:sync-retry";

export interface ConfigurationSyncApplyCallbacks {
  replaceConfiguration(configuration: Configuration): Promise<void>;
  refreshMenus(): Promise<void>;
  refreshAlarms(): Promise<void>;
  refreshViews(): Promise<void>;
  scheduleRetry(): Promise<void>;
}

export function createConfigurationSyncCoordinator(input: {
  repository: Pick<
    ConfigurationRepository,
    "applySyncChange" | "markControllerRevisionApplied"
  >;
  callbacks: ConfigurationSyncApplyCallbacks;
  recordSyncActivity?: {
    local: LocalRepository;
    now: () => number;
  };
}) {
  async function maybeRecordSyncActivity(result: SyncChangeResult): Promise<void> {
    if (!input.recordSyncActivity) return;
    let activityResult: SyncRevisionActivityResult | undefined;
    if (result.kind === "applied") activityResult = { kind: "applied" };
    else if (result.kind === "invalid")
      activityResult = { kind: "invalid", reason: result.reason };
    else if (result.kind === "pending") activityResult = { kind: "pending" };
    if (!activityResult) return;
    await recordSyncRevisionActivity(
      input.recordSyncActivity.local,
      activityResult,
      input.recordSyncActivity.now()
    );
  }

  return {
    async applySyncChange(
      changedKeys: readonly string[] = []
    ): Promise<SyncChangeResult> {
      const result = await input.repository.applySyncChange(changedKeys);
      await maybeRecordSyncActivity(result);
      if (result.kind === "pending") {
        await input.callbacks.scheduleRetry();
        return result;
      }
      if (result.kind !== "applied") return result;
      try {
        await Promise.all([
          input.callbacks.replaceConfiguration(result.configuration),
          input.callbacks.refreshMenus(),
          input.callbacks.refreshAlarms(),
          input.callbacks.refreshViews()
        ]);
        await input.repository.markControllerRevisionApplied(result.revisionId);
      } catch (error) {
        await input.callbacks.scheduleRetry();
        throw error;
      }
      return result;
    }
  };
}

export function registerConfigurationSyncIntake(input: {
  storageOnChanged: {
    addListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
  };
  alarmsOnAlarm: {
    addListener(listener: (alarm: { name: string }) => void): void;
  };
  dispatch(changedKeys: readonly string[]): void;
}) {
  let ready = false;
  let pending = false;
  const changedKeys = new Set<string>();

  function dispatch(keys: readonly string[]) {
    if (!ready) {
      pending = true;
      keys.forEach((key) => changedKeys.add(key));
      return;
    }
    input.dispatch(keys);
  }

  input.storageOnChanged.addListener((changes, areaName) => {
    if (areaName === "sync") dispatch(Object.keys(changes));
  });
  input.alarmsOnAlarm.addListener((alarm) => {
    if (alarm.name === CONFIGURATION_SYNC_RETRY_ALARM) dispatch([]);
  });

  return {
    markReady() {
      ready = true;
      const result = { pending, changedKeys: [...changedKeys] };
      pending = false;
      changedKeys.clear();
      return result;
    }
  };
}
