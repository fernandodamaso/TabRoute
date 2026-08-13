import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProductionScanFs {
  readManifest?: () => Promise<string>;
  listFiles?: () => Promise<string[]>;
  readFile?: (relativePath: string) => Promise<Uint8Array>;
}
export interface ProductionScanResult { ok: boolean; errors: string[]; buildPath: string; }
export interface ProductionGateResult {
  graph: "production";
  resultPath: string;
  workbenchBuildPath: string;
  productionBuildPath: string;
  productionScan: { ok: true };
}
const EXPECTED_PERMISSIONS = ["tabs", "tabGroups", "storage"] as const;
const MARKERS = ["TABROUTE_DEV_WORKBENCH_V1", "data-workbench-control", "tabrouteFixtureRegistryV1"] as const;
const WORKBENCH_SCENARIO_PATTERN = /wb:[a-z0-9-]+/;
const WORKBENCH_KEYS = new Set(["workbench", "workbenchUrl", "workbenchEntry", "workbenchEntrypoint", "workbench_entrypoint", "workbenchPath"]);
const LAST_PRODUCTION_GATE_POINTER = ["last-production-gate-result-path"] as const;

async function defaultFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute); else files.push(path.relative(root, absolute));
    }
  }
  await visit(root);
  return files;
}

async function readBuildAssets(
  buildPath: string,
  supplied: ProductionScanFs = {}
): Promise<{ files: string[]; readFile: (relativePath: string) => Promise<Uint8Array> }> {
  const root = path.resolve(buildPath);
  const listFiles = supplied.listFiles ?? (() => defaultFiles(root));
  const readFileAsset = supplied.readFile ?? ((relativePath: string) => readFile(path.join(root, relativePath)));
  const files = await listFiles();
  return { files, readFile: readFileAsset };
}

export async function scanProductionBuild(buildPath: string, supplied: ProductionScanFs = {}): Promise<ProductionScanResult> {
  const root = path.resolve(buildPath);
  const readManifest = supplied.readManifest ?? (() => readFile(path.join(root, "manifest.json"), "utf8"));
  const listFiles = supplied.listFiles ?? (() => defaultFiles(root));
  const readFileAsset = supplied.readFile ?? ((relativePath: string) => readFile(path.join(root, relativePath)));
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
  if ("browser_specific_settings" in manifest || "applications" in manifest || "firefox" in manifest || "edge" in manifest || "safari" in manifest || ("target" in manifest && manifest.target !== "chrome") || ("targets" in manifest && (!Array.isArray(manifest.targets) || manifest.targets.length !== 1 || manifest.targets[0] !== "chrome"))) errors.push("manifest is not Chrome-only");
  let files: string[] = [];
  try { files = await listFiles(); } catch { errors.push("production build cannot be enumerated"); }
  for (const relativePath of files) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (path.posix.extname(normalized).toLowerCase() === ".html" && path.posix.basename(normalized, ".html").toLowerCase() === "workbench") errors.push(`workbench HTML basename found: ${relativePath}`);
    let bytes: Uint8Array;
    try { bytes = await readFileAsset(relativePath); } catch { errors.push(`asset cannot be read: ${relativePath}`); continue; }
    const text = new TextDecoder().decode(bytes);
    for (const marker of MARKERS) if (text.includes(marker)) errors.push(`workbench marker found in ${relativePath}: ${marker}`);
    if (/wb:[a-z0-9-]+/.test(text)) errors.push(`workbench scenario marker found in ${relativePath}`);
  }
  return { ok: errors.length === 0, errors, buildPath: root };
}

export async function scanWorkbenchBuild(buildPath: string, supplied: ProductionScanFs = {}): Promise<ProductionScanResult> {
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
      try { bytes = await assets.readFile(relativePath); } catch { errors.push(`asset cannot be read: ${relativePath}`); continue; }
      const text = new TextDecoder().decode(bytes);
      for (const marker of MARKERS) if (text.includes(marker)) foundMarkers.add(marker);
      if (WORKBENCH_SCENARIO_PATTERN.test(text)) foundScenario = true;
    }
  } catch {
    errors.push("workbench build cannot be enumerated");
  }
  for (const marker of MARKERS) {
    if (!foundMarkers.has(marker)) errors.push(`required workbench marker missing: ${marker}`);
  }
  if (!foundScenario) errors.push("required workbench scenario marker missing");
  if (files.length === 0) errors.push("workbench build is empty");
  return { ok: errors.length === 0, errors, buildPath: root };
}

export function productionGatePointerPath(worktreePath: string): string {
  return path.join(path.resolve(worktreePath), ".workbench", "tmp", ...LAST_PRODUCTION_GATE_POINTER);
}

export async function writeProductionGateResult(
  worktreePath: string,
  runId: string,
  input: Omit<ProductionGateResult, "resultPath">
): Promise<string> {
  const artifactPath = path.join(path.resolve(worktreePath), ".workbench", "artifacts", runId);
  await mkdir(artifactPath, { recursive: true });
  const resultPath = path.join(artifactPath, "production-gate.json");
  const result: ProductionGateResult = { ...input, resultPath };
  await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
  const pointerPath = productionGatePointerPath(worktreePath);
  await mkdir(path.dirname(pointerPath), { recursive: true });
  await writeFile(pointerPath, resultPath, "utf8");
  return resultPath;
}

export async function readProductionGateResult(resultPath: string): Promise<ProductionGateResult> {
  const parsed = JSON.parse(await readFile(path.resolve(resultPath), "utf8")) as ProductionGateResult;
  if (parsed.graph !== "production" || parsed.productionScan.ok !== true)
    throw new Error("WORKBENCH_ARGUMENT: invalid production gate result");
  return parsed;
}

export const scanProduction = scanProductionBuild;
