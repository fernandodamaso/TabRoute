import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  findChromeZip,
  scanProductionZip
} from "../../scripts/workbench/production-scan";

const execFileAsync = promisify(execFile);

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

async function writeZipFixture(options: { marker?: boolean }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-zip-fixture-"));
  const payload = path.join(root, "payload");
  await mkdir(payload, { recursive: true });
  await writeFile(
    path.join(payload, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      incognito: "not_allowed",
      permissions: [...APPROVED_PERMISSIONS],
      commands: structuredClone(APPROVED_COMMANDS)
    }),
    "utf8"
  );
  await writeFile(
    path.join(payload, "options.html"),
    options.marker ? "TABROUTE_DEV_WORKBENCH_V1" : "<html></html>",
    "utf8"
  );
  const zipPath = path.join(root, "tabroute-0.1.0-chrome.zip");
  await execFileAsync("tar", ["-a", "-cf", zipPath, "-C", payload, "."]);
  return zipPath;
}

describe("production zip scan", () => {
  it("accepts a clean zip tree and rejects workbench markers inside the zip", async () => {
    const cleanZip = await writeZipFixture({ marker: false });
    const clean = await scanProductionZip(cleanZip);
    expect(clean.ok).toBe(true);

    const dirtyZip = await writeZipFixture({ marker: true });
    const dirty = await scanProductionZip(dirtyZip);
    expect(dirty.ok).toBe(false);
    expect(dirty.errors.join(" ")).toContain("marker");
  });

  it("finds the chrome zip under .output by name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-output-"));
    await writeFile(
      path.join(root, "tabroute-0.1.0-chrome.zip"),
      "zip",
      "utf8"
    );
    await expect(findChromeZip(root)).resolves.toBe(
      path.join(root, "tabroute-0.1.0-chrome.zip")
    );
  });
});
