import { defineConfig } from "wxt";

const workbenchBuild = process.env.TABROUTE_WORKBENCH === "1";
const productionWorkbenchStub = "\0tabroute-production-workbench-stub";

export default defineConfig({
  outDir: process.env.TABROUTE_WXT_OUT_DIR ?? ".output",
  modules: ["@wxt-dev/module-react"],
  manifestVersion: 3,
  targetBrowsers: ["chrome"],
  vite: () => ({
    define: {
      __TABROUTE_WORKBENCH__: JSON.stringify(workbenchBuild)
    },
    plugins: workbenchBuild
      ? []
      : [
          {
            name: "tabroute-production-workbench-exclusion",
            enforce: "pre" as const,
            resolveId(source: string, importer?: string) {
              const normalizedImporter = importer?.replaceAll("\\", "/");
              const normalizedSource = source.replaceAll("\\", "/");
              if (
                normalizedSource.includes("workbench/WorkbenchOptionsApp") &&
                normalizedImporter?.includes("/entrypoints/options/App")
              )
                return productionWorkbenchStub;
              return undefined;
            },
            load(id: string) {
              return id === productionWorkbenchStub
                ? "export function WorkbenchOptionsApp() { return null; }"
                : undefined;
            }
          }
        ]
  }),
  manifest: {
    name: "TabRoute",
    description:
      "Automatically route, preserve, and restore Chrome tab groups.",
    minimum_chrome_version: "121",
    incognito: "not_allowed",
    permissions: [
      "tabs",
      "tabGroups",
      "storage",
      "contextMenus",
      "sessions",
      "alarms"
    ],
    commands: {
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
    }
  }
});
