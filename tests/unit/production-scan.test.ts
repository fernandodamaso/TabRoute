import { describe, expect, it } from "vitest";
import { scanProductionBuild } from "../../scripts/workbench/production-scan";

describe("production build scan", () => {
  it("accepts the exact Chrome production manifest", async () => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () => JSON.stringify({ manifest_version: 3, incognito: "not_allowed", permissions: ["tabs", "tabGroups", "storage"] }),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a workbench marker and a commands entry", async () => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () => JSON.stringify({ manifest_version: 3, incognito: "not_allowed", permissions: ["tabs", "tabGroups", "storage"], commands: {} }),
      listFiles: async () => ["options.html"],
      readFile: async () => new TextEncoder().encode("TABROUTE_DEV_WORKBENCH_V1")
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("commands"), expect.stringContaining("marker")]));
  });
});
