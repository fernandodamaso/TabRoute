import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const APPROVED_COMMAND_NAMES = [
  "create-rule-from-tab",
  "make-persistent",
  "move-to-other",
  "open-manager",
  "pin-group",
  "remove-persistent",
  "save-snapshot",
  "toggle-automation",
  "undo"
].sort();

async function buildAndReadManifest() {
  execFileSync("npm", ["run", "build"], {
    stdio: "pipe",
    shell: process.platform === "win32"
  });
  return JSON.parse(
    await readFile(".output/chrome-mv3/manifest.json", "utf8")
  ) as Record<string, unknown>;
}

it("builds a Chrome MV3 manifest with menus, shortcuts, and no notifications", async () => {
  const manifest = await buildAndReadManifest();
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.minimum_chrome_version).toBe("121");
  expect(manifest.name).toBe("TabRoute");
  expect(manifest.permissions).toEqual([
    "tabs",
    "tabGroups",
    "storage",
    "contextMenus",
    "sessions",
    "alarms"
  ]);
  expect(manifest.permissions).not.toContain("notifications");
  expect(manifest.permissions).not.toContain("commands");
  expect(manifest.incognito).toBe("not_allowed");
  expect(manifest.host_permissions).toBeUndefined();
  const commands = manifest.commands as Record<string, { suggested_key?: unknown }>;
  expect(Object.keys(commands).sort()).toEqual(APPROVED_COMMAND_NAMES);
  expect(
    Object.values(commands).filter((command) => "suggested_key" in command)
  ).toHaveLength(4);
  expect(commands["open-manager"]?.suggested_key).toEqual({
    default: "Alt+Shift+M"
  });
  expect(commands["create-rule-from-tab"]?.suggested_key).toEqual({
    default: "Alt+Shift+R"
  });
  expect(commands["toggle-automation"]?.suggested_key).toEqual({
    default: "Alt+Shift+A"
  });
  expect(commands["save-snapshot"]?.suggested_key).toEqual({
    default: "Alt+Shift+S"
  });
});
