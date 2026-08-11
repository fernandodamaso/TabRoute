import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifestVersion: 3,
  targetBrowsers: ["chrome"],
  vite: () => ({
    define: {
      __TABROUTE_WORKBENCH__: JSON.stringify(process.env.TABROUTE_WORKBENCH === "1")
    }
  }),
  manifest: {
    name: "TabRoute",
    description: "Automatically route, preserve, and restore Chrome tab groups.",
    minimum_chrome_version: "121",
    incognito: "not_allowed",
    permissions: ["tabs", "tabGroups", "storage", "alarms"]
  }
});
