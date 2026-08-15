import { describe, expect, it } from "vitest";
import { scanProductionBuild } from "../../scripts/workbench/production-scan";

const APPROVED_PERMISSIONS = [
  "tabs",
  "tabGroups",
  "storage",
  "contextMenus",
  "sessions",
  "alarms"
] as const;

const APPROVED_COMMANDS = {
  "open-manager": {
    suggested_key: { default: "Alt+Shift+M" },
    description: "Open TabRoute manager"
  },
  "create-rule-from-tab": {
    suggested_key: { default: "Alt+Shift+R" },
    description: "Create rule from this tab"
  },
  "toggle-automation": {
    suggested_key: { default: "Alt+Shift+A" },
    description: "Toggle TabRoute automation"
  },
  "save-snapshot": {
    suggested_key: { default: "Alt+Shift+S" },
    description: "Save snapshot"
  },
  "make-persistent": { description: "Make this tab persistent" },
  "remove-persistent": { description: "Remove persistent tab" },
  "pin-group": { description: "Pin Group" },
  "move-to-other": { description: "Move tab to Other" },
  undo: { description: "Undo last TabRoute action" }
} as const;

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    manifest_version: 3,
    incognito: "not_allowed",
    permissions: [...APPROVED_PERMISSIONS],
    commands: structuredClone(APPROVED_COMMANDS),
    ...overrides
  };
}

describe("production build scan", () => {
  it("accepts the exact Chrome production manifest", async () => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () => JSON.stringify(validManifest()),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a workbench marker even with approved commands", async () => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () => JSON.stringify(validManifest()),
      listFiles: async () => ["options.html"],
      readFile: async () =>
        new TextEncoder().encode("TABROUTE_DEV_WORKBENCH_V1")
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("marker");
  });

  it("rejects empty commands object", async () => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () => JSON.stringify(validManifest({ commands: {} })),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("commands");
  });

  it("rejects an unknown command name", async () => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () =>
        JSON.stringify(
          validManifest({
            commands: {
              ...APPROVED_COMMANDS,
              foo: { description: "x" }
            }
          })
        ),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("commands");
  });

  it("rejects a fifth suggested_key", async () => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () =>
        JSON.stringify(
          validManifest({
            commands: {
              ...APPROVED_COMMANDS,
              "make-persistent": {
                description: "Make this tab persistent",
                suggested_key: { default: "Alt+Shift+P" }
              }
            }
          })
        ),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("suggested_key");
  });

  it('rejects "commands" inside permissions', async () => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () =>
        JSON.stringify(
          validManifest({
            permissions: [...APPROVED_PERMISSIONS, "commands"]
          })
        ),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/permissions|commands/);
  });

  it.each([
    ["removed", ["tabs", "storage"]],
    [
      "duplicate",
      [
        "tabs",
        "tabs",
        "tabGroups",
        "storage",
        "contextMenus",
        "sessions",
        "alarms"
      ]
    ],
    [
      "wrong order",
      ["tabs", "tabGroups", "storage", "sessions", "contextMenus", "alarms"]
    ]
  ])("rejects %s permission mutations", async (_name, permissions) => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () => JSON.stringify(validManifest({ permissions })),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(result.ok).toBe(false);
  });

  it("recursively rejects nested workbench paths and marker bytes without rejecting binary assets", async () => {
    const marker = new TextEncoder().encode("TABROUTE_DEV_WORKBENCH_V1");
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () =>
        JSON.stringify(
          validManifest({ nested: { entry: "assets/workbench.html" } })
        ),
      listFiles: async () => ["assets/data.bin", "nested/page.js"],
      readFile: async (file) =>
        file.endsWith("bin")
          ? new Uint8Array([0, 255, ...marker])
          : new TextEncoder().encode(
              "ordinary ChromeManagerTransport default loading offline"
            )
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("marker");
    expect(result.errors.join(" ")).toContain("workbench");
    const valid = await scanProductionBuild("C:/build", {
      readManifest: async () => JSON.stringify(validManifest()),
      listFiles: async () => ["data.bin"],
      readFile: async () => new Uint8Array([0, 255, 1, 2])
    });
    expect(valid.ok).toBe(true);
  });

  it("rejects mixed and non-Chrome targets", async () => {
    for (const target of [["chrome", "firefox"], ["firefox"]]) {
      const result = await scanProductionBuild("C:/build", {
        readManifest: async () =>
          JSON.stringify(validManifest({ targets: target })),
        listFiles: async () => [],
        readFile: async () => new Uint8Array()
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects host_permissions even when the permissions array is exact", async () => {
    const result = await scanProductionBuild("C:/build", {
      readManifest: async () =>
        JSON.stringify(
          validManifest({ host_permissions: ["https://example.com/*"] })
        ),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("host_permissions");
  });

  it("rejects notifications and unlimitedStorage permission surface", async () => {
    const withNotifications = await scanProductionBuild("C:/build", {
      readManifest: async () =>
        JSON.stringify(
          validManifest({
            permissions: [...APPROVED_PERMISSIONS, "notifications"]
          })
        ),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(withNotifications.ok).toBe(false);
    expect(withNotifications.errors.join(" ")).toMatch(
      /notifications|permissions/
    );

    const withUnlimited = await scanProductionBuild("C:/build", {
      readManifest: async () =>
        JSON.stringify(
          validManifest({
            permissions: [...APPROVED_PERMISSIONS, "unlimitedStorage"]
          })
        ),
      listFiles: async () => [],
      readFile: async () => new Uint8Array()
    });
    expect(withUnlimited.ok).toBe(false);
    expect(withUnlimited.errors.join(" ")).toMatch(
      /unlimitedStorage|permissions/
    );
  });
});
