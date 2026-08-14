import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createArtifactStore, encodeUtf8 } from "./artifacts";

const execFileAsync = promisify(execFile);

export interface ProductionScanFs {
  readManifest?: () => Promise<string>;
  listFiles?: () => Promise<string[]>;
  readFile?: (relativePath: string) => Promise<Uint8Array>;
}
export interface ProductionScanResult {
  ok: boolean;
  errors: string[];
  buildPath: string;
}
export interface ProductionGateResult {
  graph: "production";
  resultPath: string;
  workbenchBuildPath: string;
  productionBuildPath: string;
  productionScan: { ok: true };
}
const EXPECTED_PERMISSIONS = [
  "tabs",
  "tabGroups",
  "storage",
  "contextMenus",
  "sessions",
  "alarms"
] as const;

const APPROVED_COMMAND_NAMES = [
  "open-manager",
  "create-rule-from-tab",
  "toggle-automation",
  "save-snapshot",
  "make-persistent",
  "remove-persistent",
  "pin-group",
  "move-to-other",
  "undo"
] as const;

const APPROVED_SUGGESTED_KEYS: Record<string, string> = {
  "open-manager": "Alt+Shift+M",
  "create-rule-from-tab": "Alt+Shift+R",
  "toggle-automation": "Alt+Shift+A",
  "save-snapshot": "Alt+Shift+S"
};
const MARKERS = [
  "TABROUTE_DEV_WORKBENCH_V1",
  "data-workbench-control",
  "tabrouteFixtureRegistryV1"
] as const;
const WORKBENCH_SCENARIO_PATTERN = /wb:[a-z0-9-]+/;
const WORKBENCH_KEYS = new Set([
  "workbench",
  "workbenchUrl",
  "workbenchEntry",
  "workbenchEntrypoint",
  "workbench_entrypoint",
  "workbenchPath"
]);
const LAST_PRODUCTION_GATE_POINTER = [
  "last-production-gate-result-path"
] as const;

async function defaultFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else files.push(path.relative(root, absolute));
    }
  }
  await visit(root);
  return files;
}

async function readBuildAssets(
  buildPath: string,
  supplied: ProductionScanFs = {}
): Promise<{
  files: string[];
  readFile: (relativePath: string) => Promise<Uint8Array>;
}> {
  const root = path.resolve(buildPath);
  const listFiles = supplied.listFiles ?? (() => defaultFiles(root));
  const readFileAsset =
    supplied.readFile ??
    ((relativePath: string) => readFile(path.join(root, relativePath)));
  const files = await listFiles();
  return { files, readFile: readFileAsset };
}

export async function scanProductionBuild(
  buildPath: string,
  supplied: ProductionScanFs = {}
): Promise<ProductionScanResult> {
  const root = path.resolve(buildPath);
  const readManifest =
    supplied.readManifest ??
    (() => readFile(path.join(root, "manifest.json"), "utf8"));
  const listFiles = supplied.listFiles ?? (() => defaultFiles(root));
  const readFileAsset =
    supplied.readFile ??
    ((relativePath: string) => readFile(path.join(root, relativePath)));
  const errors: string[] = [];
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await readManifest()) as Record<string, unknown>;
  } catch {
    errors.push("manifest.json is missing or invalid JSON");
  }
  if (manifest.manifest_version !== 3)
    errors.push("manifest_version must be 3");
  if (manifest.incognito !== "not_allowed")
    errors.push('incognito must be "not_allowed"');
  if ("host_permissions" in manifest)
    errors.push("manifest must not declare host_permissions");
  if ("optional_host_permissions" in manifest)
    errors.push("manifest must not declare optional_host_permissions");
  const commands = manifest.commands;
  if (
    commands === undefined ||
    typeof commands !== "object" ||
    commands === null ||
    Array.isArray(commands)
  ) {
    errors.push("manifest commands do not match the approved set");
  } else {
    const entries = Object.entries(commands as Record<string, unknown>);
    const names = entries.map(([name]) => name).sort();
    const expected = [...APPROVED_COMMAND_NAMES].sort();
    if (
      names.length !== expected.length ||
      names.some((name, index) => name !== expected[index])
    ) {
      errors.push("manifest commands do not match the approved set");
    }
    let suggestedCount = 0;
    for (const [name, value] of entries) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`manifest command ${name} is invalid`);
        continue;
      }
      const command = value as Record<string, unknown>;
      if ("suggested_key" in command) {
        suggestedCount += 1;
        const suggested = command.suggested_key;
        const expectedKey = APPROVED_SUGGESTED_KEYS[name];
        if (!expectedKey) {
          errors.push("manifest commands contain an unexpected suggested_key");
          continue;
        }
        if (
          !suggested ||
          typeof suggested !== "object" ||
          Array.isArray(suggested) ||
          (suggested as { default?: unknown }).default !== expectedKey
        ) {
          errors.push(`manifest command ${name} has an invalid suggested_key`);
        }
      } else if (name in APPROVED_SUGGESTED_KEYS) {
        errors.push(`manifest command ${name} is missing suggested_key`);
      }
    }
    if (suggestedCount !== 4) {
      errors.push(
        "manifest commands must declare exactly four suggested_key values"
      );
    }
  }
  const permissions = manifest.permissions;
  if (
    !Array.isArray(permissions) ||
    permissions.some((permission) => typeof permission !== "string")
  )
    errors.push("manifest permissions are invalid");
  else {
    const values = permissions as string[];
    if (new Set(values).size !== values.length)
      errors.push("manifest permissions contain duplicates");
    if (
      values.length !== EXPECTED_PERMISSIONS.length ||
      values.some((value, index) => value !== EXPECTED_PERMISSIONS[index])
    )
      errors.push("manifest permissions do not match the approved set");
    if (values.includes("commands"))
      errors.push('manifest permissions must not include "commands"');
    if (values.includes("notifications"))
      errors.push('manifest permissions must not include "notifications"');
    if (values.includes("unlimitedStorage"))
      errors.push('manifest permissions must not include "unlimitedStorage"');
  }
  const inspectManifest = (value: unknown, keyPath: string): void => {
    if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (
          WORKBENCH_KEYS.has(key) ||
          (/workbench/i.test(key) && /(entry|path|html|url)/i.test(key))
        )
          errors.push(
            `manifest contains workbench entrypoint: ${keyPath}.${key}`
          );
        inspectManifest(child, `${keyPath}.${key}`);
      }
    else if (
      typeof value === "string" &&
      (/(^|[\\/])workbench\.html$/i.test(value) ||
        /(^|[\\/])workbench([\\/]|$)/i.test(value))
    )
      errors.push(`manifest contains workbench path: ${keyPath}`);
  };
  inspectManifest(manifest, "manifest");
  if (
    "browser_specific_settings" in manifest ||
    "applications" in manifest ||
    "firefox" in manifest ||
    "edge" in manifest ||
    "safari" in manifest ||
    ("target" in manifest && manifest.target !== "chrome") ||
    ("targets" in manifest &&
      (!Array.isArray(manifest.targets) ||
        manifest.targets.length !== 1 ||
        manifest.targets[0] !== "chrome"))
  )
    errors.push("manifest is not Chrome-only");
  let files: string[] = [];
  try {
    files = await listFiles();
  } catch {
    errors.push("production build cannot be enumerated");
  }
  for (const relativePath of files) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (
      path.posix.extname(normalized).toLowerCase() === ".html" &&
      path.posix.basename(normalized, ".html").toLowerCase() === "workbench"
    )
      errors.push(`workbench HTML basename found: ${relativePath}`);
    let bytes: Uint8Array;
    try {
      bytes = await readFileAsset(relativePath);
    } catch {
      errors.push(`asset cannot be read: ${relativePath}`);
      continue;
    }
    const text = new TextDecoder().decode(bytes);
    for (const marker of MARKERS)
      if (text.includes(marker))
        errors.push(`workbench marker found in ${relativePath}: ${marker}`);
    if (/wb:[a-z0-9-]+/.test(text))
      errors.push(`workbench scenario marker found in ${relativePath}`);
  }
  return { ok: errors.length === 0, errors, buildPath: root };
}

export async function scanWorkbenchBuild(
  buildPath: string,
  supplied: ProductionScanFs = {}
): Promise<ProductionScanResult> {
  const root = path.resolve(buildPath);
  const errors: string[] = [];
  const foundMarkers = new Set<string>();
  let foundScenario = false;
  let files: string[] = [];
  try {
    const assets = await readBuildAssets(buildPath, supplied);
    files = assets.files;
    for (const relativePath of files) {
      let bytes: Uint8Array;
      try {
        bytes = await assets.readFile(relativePath);
      } catch {
        errors.push(`asset cannot be read: ${relativePath}`);
        continue;
      }
      const text = new TextDecoder().decode(bytes);
      for (const marker of MARKERS)
        if (text.includes(marker)) foundMarkers.add(marker);
      if (WORKBENCH_SCENARIO_PATTERN.test(text)) foundScenario = true;
    }
  } catch {
    errors.push("workbench build cannot be enumerated");
  }
  for (const marker of MARKERS) {
    if (!foundMarkers.has(marker))
      errors.push(`required workbench marker missing: ${marker}`);
  }
  if (!foundScenario) errors.push("required workbench scenario marker missing");
  if (files.length === 0) errors.push("workbench build is empty");
  return { ok: errors.length === 0, errors, buildPath: root };
}

export function productionGatePointerPath(worktreePath: string): string {
  return path.join(
    path.resolve(worktreePath),
    ".workbench",
    "tmp",
    ...LAST_PRODUCTION_GATE_POINTER
  );
}

export async function writeProductionGateResult(
  worktreePath: string,
  runId: string,
  input: Omit<ProductionGateResult, "resultPath">
): Promise<string> {
  const artifactPath = path.join(
    path.resolve(worktreePath),
    ".workbench",
    "artifacts",
    runId
  );
  const store = createArtifactStore({
    root: artifactPath,
    runId
  });
  const resultPath = path.join(artifactPath, "production-gate.json");
  const result: ProductionGateResult = { ...input, resultPath };
  await store.write(
    "production-gate.json",
    encodeUtf8(JSON.stringify(result, null, 2)),
    "result"
  );
  await store.finalize("completed");
  const pointerPath = productionGatePointerPath(worktreePath);
  await mkdir(path.dirname(pointerPath), { recursive: true });
  await writeFile(pointerPath, resultPath, "utf8");
  return resultPath;
}

export async function readProductionGateResult(
  resultPath: string
): Promise<ProductionGateResult> {
  const parsed = JSON.parse(
    await readFile(path.resolve(resultPath), "utf8")
  ) as ProductionGateResult;
  if (parsed.graph !== "production" || parsed.productionScan.ok !== true)
    throw new Error("WORKBENCH_ARGUMENT: invalid production gate result");
  return parsed;
}

export async function extractZipArchive(
  zipPath: string,
  destination: string
): Promise<void> {
  await mkdir(destination, { recursive: true });
  await execFileAsync("tar", ["-xf", path.resolve(zipPath), "-C", destination]);
}

export async function scanProductionZip(
  zipPath: string
): Promise<ProductionScanResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tabroute-zip-scan-"));
  try {
    await extractZipArchive(zipPath, root);
    return await scanProductionBuild(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function findChromeZip(outputRoot = ".output"): Promise<string> {
  const absolute = path.resolve(outputRoot);
  const entries = await readdir(absolute);
  const match = entries
    .filter((name) => /^tabroute-.*-chrome\.zip$/i.test(name))
    .sort()
    .at(-1);
  if (!match) throw new Error(`Chrome zip not found under ${absolute}`);
  return path.join(absolute, match);
}

export const scanProduction = scanProductionBuild;
