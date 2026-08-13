import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

async function buildAndReadManifest() {
  execFileSync("npm", ["run", "build"], { stdio: "pipe", shell: process.platform === "win32" });
  return JSON.parse(await readFile(".output/chrome-mv3/manifest.json", "utf8")) as Record<string, unknown>;
}

it("builds a Chrome MV3 manifest without incognito or notification capability", async () => {
  const manifest = await buildAndReadManifest();
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.minimum_chrome_version).toBe("121");
  expect(manifest.name).toBe("TabRoute");
  expect(manifest.permissions).toEqual([
    "tabs",
    "tabGroups",
    "storage",
    "sessions",
    "alarms"
  ]);
  expect(manifest.permissions).not.toContain("notifications");
  expect(manifest.permissions).not.toContain("commands");
  expect(manifest.permissions).not.toContain("contextMenus");
  expect(manifest.incognito).toBe("not_allowed");
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.commands).toBeUndefined();
});
