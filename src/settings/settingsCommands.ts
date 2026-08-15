import type { Configuration, DuplicateSettings } from "../domain/types";
import { setRestorePersistentGroups } from "../persistence/persistentCommands";

export function setAutomationEnabled(
  configuration: Configuration,
  enabled: boolean,
  now: () => number
): Configuration {
  return { ...configuration, automationEnabled: enabled, updatedAt: now() };
}

export function setDuplicateSettings(
  configuration: Configuration,
  settings: DuplicateSettings,
  now: () => number
): Configuration {
  return {
    ...configuration,
    duplicateSettings: {
      globalPolicy: settings.globalPolicy,
      globalExclusions: [...settings.globalExclusions],
      trackingParameters: [...settings.trackingParameters]
    },
    updatedAt: now()
  };
}

export function setSnapshotIntervalMinutes(
  configuration: Configuration,
  minutes: number,
  now: () => number
): Configuration {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("snapshot interval must be positive");
  }
  return {
    ...configuration,
    snapshotIntervalMinutes: minutes,
    updatedAt: now()
  };
}

export { setRestorePersistentGroups };
