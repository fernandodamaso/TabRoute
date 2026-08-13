import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { validateConfiguration } from "../../src/domain/schemas";
import {
  exportPortableConfiguration,
  parsePortableConfigurationImport
} from "../../src/settings/portableConfiguration";

describe("portable configuration import/export", () => {
  it("exports and re-imports a valid configuration", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const exported = exportPortableConfiguration(configuration);
    const parsed = parsePortableConfigurationImport(JSON.parse(exported));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateConfiguration(parsed.configuration)).toEqual(parsed.configuration);
  });

  it("rejects mixed sync generation keys", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const payload = {
      ...configuration,
      "config:v1:head": { revisionId: "rev-1" }
    };
    const result = parsePortableConfigurationImport(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("IMPORT_NON_PORTABLE");
  });

  it("rejects runtime id keys", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const result = parsePortableConfigurationImport({
      ...configuration,
      tabId: 42
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("IMPORT_RUNTIME_IDS");
  });

  it("rejects snapshot and activity bags", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    for (const extra of [{ snapshots: [] }, { activity: [] }, { undo: {} }]) {
      const result = parsePortableConfigurationImport({ ...configuration, ...extra });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("IMPORT_NON_PORTABLE");
    }
  });

  it("rejects a disabled fallback group", () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const result = parsePortableConfigurationImport({
      ...configuration,
      groups: configuration.groups.map((group) =>
        group.isFallback ? { ...group, enabled: false } : group
      )
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("IMPORT_INVALID_FALLBACK");
  });
});
