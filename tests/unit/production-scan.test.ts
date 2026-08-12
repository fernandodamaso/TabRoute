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

  it.each([
    ["added", ["tabs", "tabGroups", "storage", "alarms"]],
    ["removed", ["tabs", "storage"]],
    ["duplicate", ["tabs", "tabs", "tabGroups", "storage"]],
    ["wrong order", ["storage", "tabs", "tabGroups"]]
  ])("rejects %s permission mutations", async (_name, permissions) => {
    const result = await scanProductionBuild("C:/build", { readManifest: async () => JSON.stringify({ manifest_version: 3, incognito: "not_allowed", permissions }), listFiles: async () => [], readFile: async () => new Uint8Array() });
    expect(result.ok).toBe(false);
  });

  it("recursively rejects nested workbench paths and marker bytes without rejecting binary assets", async () => {
    const marker = new TextEncoder().encode("TABROUTE_DEV_WORKBENCH_V1");
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () => JSON.stringify({ manifest_version: 3, incognito: "not_allowed", permissions: ["tabs", "tabGroups", "storage"], nested: { entry: "assets/workbench.html" } }),
      listFiles: async () => ["assets/data.bin", "nested/page.js"],
      readFile: async (file) => file.endsWith("bin") ? new Uint8Array([0, 255, ...marker]) : new TextEncoder().encode("ordinary ChromeManagerTransport default loading offline")
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("marker");
    expect(result.errors.join(" ")).toContain("workbench");
    const valid = await scanProductionBuild("C:/build", { readManifest: async () => JSON.stringify({ manifest_version: 3, incognito: "not_allowed", permissions: ["tabs", "tabGroups", "storage"] }), listFiles: async () => ["data.bin"], readFile: async () => new Uint8Array([0, 255, 1, 2]) });
    expect(valid.ok).toBe(true);
  });
});
