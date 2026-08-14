import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";

interface SourceManifestEntry {
  id: string;
  file: string;
  url: string;
  purpose: string;
  retrievedAtUtc?: string;
  sha256?: string;
}

interface SourceManifest {
  schemaVersion: number;
  licenseNotice: string;
  sources: SourceManifestEntry[];
}

export interface RefreshSource extends SourceManifestEntry {
  retrievedAtUtc: string;
  sha256: string;
}

export interface RefreshResult {
  updatedIds: string[];
  sources: RefreshSource[];
}

const LICENSE =
  "CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.";

async function readManifest(rootDir: string): Promise<SourceManifest> {
  const manifestPath = join(rootDir, "docs/chrome-reference/sources.json");
  const parsed = JSON.parse(
    await readFile(manifestPath, "utf8")
  ) as SourceManifest;
  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    throw new Error("Chrome source manifest has no sources");
  }
  for (const source of parsed.sources) {
    if (!source.id || !source.file || !source.url || !source.purpose) {
      throw new Error(
        `Invalid Chrome source manifest entry: ${source.id ?? "unknown"}`
      );
    }
    const parsedUrl = new URL(source.url);
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== "developer.chrome.com"
    ) {
      throw new Error(`Non-allowlisted Chrome source URL: ${source.url}`);
    }
  }
  return parsed;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function articleText(html: string) {
  const document = load(html);
  const article = document("article").first();
  (article.length > 0 ? article : document("body"))
    .find("script,style,noscript")
    .remove();
  const text = (article.length > 0 ? article : document("body"))
    .text()
    .replace(/\s+/g, " ")
    .trim();
  if (!text)
    throw new Error("Chrome source page contains no readable article text");
  return text;
}

function renderSnapshot(source: RefreshSource, html: string) {
  const document = load(html);
  const title =
    document("h1").first().text().replace(/\s+/g, " ").trim() || source.id;
  return [
    `Source URL: ${source.url}`,
    `Source title: ${title}`,
    `Retrieved at (UTC): ${source.retrievedAtUtc}`,
    `License: ${LICENSE}`,
    `Source SHA-256: ${source.sha256}`,
    "",
    `Purpose: ${source.purpose}`,
    "",
    articleText(html),
    ""
  ]
    .join("\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

async function validateStagedSet(
  rootDir: string,
  stagedVendor: string,
  sources: RefreshSource[]
) {
  for (const source of sources) {
    const snapshot = await readFile(
      join(stagedVendor, source.file.replace(/^vendor[\\/]/, "")),
      "utf8"
    );
    if (
      !snapshot.includes(`Source URL: ${source.url}`) ||
      !snapshot.includes(`Source SHA-256: ${source.sha256}`)
    ) {
      throw new Error(`Invalid staged Chrome snapshot: ${source.id}`);
    }
  }
  if (!rootDir) throw new Error("rootDir is required");
}

async function swapDirectory(
  rootDir: string,
  stagedVendor: string,
  manifest: SourceManifest
) {
  const docsRoot = join(rootDir, "docs/chrome-reference");
  const vendor = join(docsRoot, "vendor");
  const manifestPath = join(docsRoot, "sources.json");
  const stagedManifest = `${manifestPath}.staged`;
  const backupVendor = `${vendor}.backup`;
  const backupManifest = `${manifestPath}.backup`;
  let oldVendorMoved = false;
  let newVendorMoved = false;
  let oldManifestMoved = false;
  let newManifestMoved = false;
  await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(backupVendor, { recursive: true, force: true });
  await rm(backupManifest, { force: true });
  try {
    await rename(vendor, backupVendor);
    oldVendorMoved = true;
    await rename(stagedVendor, vendor);
    newVendorMoved = true;
    await rename(manifestPath, backupManifest);
    oldManifestMoved = true;
    await rename(stagedManifest, manifestPath);
    newManifestMoved = true;
  } catch (error) {
    if (newManifestMoved) await rm(manifestPath, { force: true });
    if (newVendorMoved) await rm(vendor, { recursive: true, force: true });
    if (oldManifestMoved) {
      await rename(backupManifest, manifestPath).catch(() => undefined);
    }
    if (oldVendorMoved) {
      await rename(backupVendor, vendor).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(stagedManifest, { force: true });
  }
  await rm(backupVendor, { recursive: true, force: true });
  await rm(backupManifest, { force: true });
}

export async function updateChromeDocs(input: {
  rootDir: string;
  fetchImpl: typeof fetch;
  now: () => Date;
}): Promise<RefreshResult> {
  const rootDir = resolve(input.rootDir);
  const manifest = await readManifest(rootDir);
  const retrievedAtUtc = input.now().toISOString();
  const stagedVendor = join(
    rootDir,
    `docs/chrome-reference/vendor.staged-${process.pid}-${Date.now()}`
  );
  await mkdir(stagedVendor, { recursive: true });
  const refreshed: RefreshSource[] = [];
  try {
    for (const source of manifest.sources) {
      const response = await input.fetchImpl(source.url);
      if (response.status !== 200)
        throw new Error(`${source.id}: HTTP ${response.status}`);
      const finalUrl = response.url || source.url;
      if (new URL(finalUrl).hostname !== "developer.chrome.com") {
        throw new Error(
          `${source.id}: final URL is outside developer.chrome.com`
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const refreshedSource: RefreshSource = {
        ...source,
        retrievedAtUtc,
        sha256: sha256(bytes)
      };
      refreshed.push(refreshedSource);
      const relativeFile = source.file.replace(/^vendor[\\/]/, "");
      const outputPath = join(stagedVendor, relativeFile);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(
        outputPath,
        renderSnapshot(refreshedSource, new TextDecoder().decode(bytes))
      );
    }
    const readme = await readFile(
      join(rootDir, "docs/chrome-reference/vendor/README.md"),
      "utf8"
    ).catch(() => "# Official source snapshots\n");
    await writeFile(join(stagedVendor, "README.md"), readme);
    const updatedManifest: SourceManifest = { ...manifest, sources: refreshed };
    await validateStagedSet(rootDir, stagedVendor, refreshed);
    await swapDirectory(rootDir, stagedVendor, updatedManifest);
    return {
      updatedIds: refreshed.map((source) => source.id),
      sources: refreshed
    };
  } catch (error) {
    await rm(stagedVendor, { recursive: true, force: true });
    throw error;
  }
}

export async function validateChromeDocs(rootDir: string) {
  const manifest = await readManifest(resolve(rootDir));
  for (const source of manifest.sources) {
    if (
      !source.retrievedAtUtc ||
      !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(source.retrievedAtUtc)
    ) {
      throw new Error(`${source.id}: missing retrievedAtUtc`);
    }
    if (!source.sha256 || !/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new Error(`${source.id}: missing sha256`);
    }
    const snapshot = await readFile(
      join(rootDir, "docs/chrome-reference", source.file),
      "utf8"
    );
    if (
      !snapshot.includes(`Source URL: ${source.url}`) ||
      !snapshot.includes(`Retrieved at (UTC): ${source.retrievedAtUtc}`) ||
      !snapshot.includes(`Source SHA-256: ${source.sha256}`)
    ) {
      throw new Error(`${source.id}: snapshot metadata is incomplete`);
    }
  }
  return {
    valid: true,
    checkedIds: manifest.sources.map((source) => source.id)
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  const rootDir = process.cwd();
  if (process.argv.includes("--check")) {
    await validateChromeDocs(rootDir);
    console.log("Chrome reference pack is valid.");
  } else {
    const result = await updateChromeDocs({
      rootDir,
      fetchImpl: fetch,
      now: () => new Date()
    });
    console.log(`Updated Chrome sources: ${result.updatedIds.join(", ")}`);
  }
}
