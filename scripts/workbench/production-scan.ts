import { promises as fs } from "node:fs";
import path from "node:path";

export interface ProductionScanFs {
  readManifest?: () => Promise<string>;
  listFiles?: () => Promise<string[]>;
  readFile?: (relativePath: string) => Promise<Uint8Array>;
}
export interface ProductionScanResult { ok: boolean; errors: string[]; buildPath: string; }
const EXPECTED_PERMISSIONS = ["tabs", "tabGroups", "storage"] as const;
const MARKERS = ["TABROUTE_DEV_WORKBENCH_V1", "data-workbench-control", "tabrouteFixtureRegistryV1"] as const;
const WORKBENCH_KEYS = new Set(["workbench", "workbenchUrl", "workbenchEntry", "workbenchEntrypoint", "workbench_entrypoint", "workbenchPath"]);

async function defaultFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute); else files.push(path.relative(root, absolute));
    }
  }
  await visit(root);
  return files;
}

export async function scanProductionBuild(buildPath: string, supplied: ProductionScanFs = {}): Promise<ProductionScanResult> {
  const root = path.resolve(buildPath);
  const readManifest = supplied.readManifest ?? (() => fs.readFile(path.join(root, "manifest.json"), "utf8"));
  const listFiles = supplied.listFiles ?? (() => defaultFiles(root));
  const readFile = supplied.readFile ?? ((relativePath: string) => fs.readFile(path.join(root, relativePath)));
  const errors: string[] = [];
  let manifest: Record<string, unknown> = {};
  try { manifest = JSON.parse(await readManifest()) as Record<string, unknown>; } catch { errors.push("manifest.json is missing or invalid JSON"); }
  if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
  if (manifest.incognito !== "not_allowed") errors.push('incognito must be "not_allowed"');
  if ("commands" in manifest) errors.push("manifest commands are not allowed");
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || permissions.some((permission) => typeof permission !== "string")) errors.push("manifest permissions are invalid");
  else {
    const values = permissions as string[];
    if (new Set(values).size !== values.length) errors.push("manifest permissions contain duplicates");
    if (values.length !== EXPECTED_PERMISSIONS.length || values.some((value, index) => value !== EXPECTED_PERMISSIONS[index])) errors.push("manifest permissions do not match the approved set");
  }
  const inspectManifest = (value: unknown, keyPath: string): void => {
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      if (WORKBENCH_KEYS.has(key) || /workbench/i.test(key) && /(entry|path|html|url)/i.test(key)) errors.push(`manifest contains workbench entrypoint: ${keyPath}.${key}`);
      inspectManifest(child, `${keyPath}.${key}`);
    } else if (typeof value === "string" && (/(^|[\\/])workbench\.html$/i.test(value) || /(^|[\\/])workbench([\\/]|$)/i.test(value))) errors.push(`manifest contains workbench path: ${keyPath}`);
  };
  inspectManifest(manifest, "manifest");
  if ("browser_specific_settings" in manifest || "applications" in manifest || "firefox" in manifest || "edge" in manifest || "safari" in manifest || ("target" in manifest && manifest.target !== "chrome") || ("targets" in manifest && JSON.stringify(manifest.targets).toLowerCase().includes("chrome") === false)) errors.push("manifest is not Chrome-only");
  let files: string[] = [];
  try { files = await listFiles(); } catch { errors.push("production build cannot be enumerated"); }
  for (const relativePath of files) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (path.posix.extname(normalized).toLowerCase() === ".html" && path.posix.basename(normalized, ".html").toLowerCase() === "workbench") errors.push(`workbench HTML basename found: ${relativePath}`);
    let bytes: Uint8Array;
    try { bytes = await readFile(relativePath); } catch { errors.push(`asset cannot be read: ${relativePath}`); continue; }
    const text = new TextDecoder().decode(bytes);
    for (const marker of MARKERS) if (text.includes(marker)) errors.push(`workbench marker found in ${relativePath}: ${marker}`);
    if (/wb:[a-z0-9-]+/.test(text)) errors.push(`workbench scenario marker found in ${relativePath}`);
  }
  return { ok: errors.length === 0, errors, buildPath: root };
}

export const scanProduction = scanProductionBuild;
