import { validateConfiguration } from "../domain/schemas";
import type { Configuration } from "../domain/types";

export type PortableImportResult =
  | { ok: true; configuration: Configuration }
  | { ok: false; code: string; message: string };

const RUNTIME_ID_KEYS = new Set([
  "tabId",
  "groupId",
  "windowId",
  "chromeTabId",
  "chromeGroupId",
  "chromeWindowId"
]);
const NON_PORTABLE_BAG_KEYS = new Set(["snapshots", "activity", "undo"]);

function isNonPortableKey(key: string): boolean {
  return (
    key.startsWith("config:v1:") ||
    key === "shutdown-latest" ||
    NON_PORTABLE_BAG_KEYS.has(key)
  );
}

function hasRuntimeIdKeys(value: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => stack.push(entry));
      continue;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (RUNTIME_ID_KEYS.has(key)) return true;
      if (isNonPortableKey(key)) return true;
      stack.push(entry);
    }
  }
  return false;
}

export function exportPortableConfiguration(
  configuration: Configuration
): string {
  return JSON.stringify(validateConfiguration(configuration), null, 2);
}

export function parsePortableConfigurationImport(
  payload: unknown
): PortableImportResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      code: "IMPORT_INVALID",
      message: "Import must be a configuration object"
    };
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isNonPortableKey(key)) {
      return {
        ok: false,
        code: "IMPORT_NON_PORTABLE",
        message: "Import must contain portable configuration only"
      };
    }
  }
  if (hasRuntimeIdKeys(payload)) {
    return {
      ok: false,
      code: "IMPORT_RUNTIME_IDS",
      message: "Import must not contain runtime Chrome identifiers"
    };
  }
  try {
    const configuration = validateConfiguration(payload);
    const fallback = configuration.groups.find((group) => group.isFallback);
    if (!fallback?.enabled) {
      return {
        ok: false,
        code: "IMPORT_INVALID_FALLBACK",
        message: "Fallback group must remain enabled"
      };
    }
    return { ok: true, configuration };
  } catch (error) {
    return {
      ok: false,
      code: "IMPORT_INVALID",
      message: error instanceof Error ? error.message : "Invalid configuration"
    };
  }
}
