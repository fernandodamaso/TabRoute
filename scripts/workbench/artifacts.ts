import { promises as fs } from "node:fs";
import path from "node:path";
import { createArtifactLimitFailure, capRunMetadata, REQUIRED_METADATA_RESERVATION_BYTES, type ArtifactKind, type ArtifactStore } from "./contracts";
import { createCrossProcessLock } from "./lock";

export const ACTIVE_RUN_BUDGET_BYTES = 50 * 1024 * 1024;
export const GLOBAL_BUDGET_BYTES = 200 * 1024 * 1024;
export const TEXT_LOG_BUDGET_BYTES = 5 * 1024 * 1024;
export const TERMINAL_RUN_LIMIT = 20;
export const TERMINAL_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TerminalRun { runId: string; terminalAt: number; }
export type EvidenceCategory = "video" | "trace" | "screenshot";
export interface OptionalEvidence { runId: string; relativePath: string; capturedAt: number; category: EvidenceCategory; }

export const orderTerminalRuns = <T extends TerminalRun>(runs: readonly T[]): T[] => [...runs].sort((a, b) => a.terminalAt - b.terminalAt || a.runId.localeCompare(b.runId));
export const orderOptionalEvidence = <T extends OptionalEvidence>(items: readonly T[]): T[] => [...items].sort((a, b) => a.capturedAt - b.capturedAt || a.runId.localeCompare(b.runId) || a.relativePath.localeCompare(b.relativePath));
export const encodeUtf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
export const capMetadata = capRunMetadata;

export function rotateTextLog(bytes: Uint8Array, maxBytes = TEXT_LOG_BUDGET_BYTES): Uint8Array {
  return bytes.byteLength <= maxBytes ? bytes : bytes.slice(bytes.byteLength - maxBytes);
}

export function encodeRequiredMetadata(metadata: Record<string, unknown>, reservationBytes = REQUIRED_METADATA_RESERVATION_BYTES): { ok: true; bytes: Uint8Array; value: Record<string, unknown> } | { ok: false; bytes: Uint8Array; value: Record<string, unknown> } {
  const value = capMetadata(metadata);
  const bytes = encodeUtf8(JSON.stringify(value));
  return bytes.byteLength <= reservationBytes ? { ok: true, bytes, value } : { ok: false, bytes, value };
}

export async function writeAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface ArtifactStoreOptions {
  root: string;
  runId: string;
  globalRoot?: string;
  activeBudgetBytes?: number;
  globalBudgetBytes?: number;
  clock?: () => number;
}

const requiredKinds = new Set<ArtifactKind>(["lease", "status", "result", "error"]);
const categoryFor = (relativePath: string): EvidenceCategory | undefined => {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("video")) return "video";
  if (normalized.includes("trace")) return "trace";
  if (normalized.includes("screenshot")) return "screenshot";
  return undefined;
};

async function filesUnder(root: string): Promise<Array<{ absolutePath: string; relativePath: string; size: number; capturedAt: number }>> {
  const entries: Array<{ absolutePath: string; relativePath: string; size: number; capturedAt: number }> = [];
  async function visit(directory: string): Promise<void> {
    let children: import("node:fs").Dirent[];
    try { children = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) await visit(absolutePath);
      else {
        const stat = await fs.stat(absolutePath);
        entries.push({ absolutePath, relativePath: path.relative(root, absolutePath), size: stat.size, capturedAt: stat.mtimeMs });
      }
    }
  }
  await visit(root);
  return entries;
}

export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore & { writeRequiredResult(metadata: Record<string, unknown>): Promise<void> } {
  const root = path.resolve(options.root);
  const globalRoot = path.resolve(options.globalRoot ?? path.dirname(root));
  const lock = createCrossProcessLock(path.join(globalRoot, ".lock"), { runId: options.runId });
  const activeBudget = options.activeBudgetBytes ?? ACTIVE_RUN_BUDGET_BYTES;
  const globalBudget = options.globalBudgetBytes ?? GLOBAL_BUDGET_BYTES;
  const clock = options.clock ?? Date.now;
  const pathFor = (relativePath: string) => {
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("artifact path escapes run root");
    return target;
  };
  async function prune(requiredBytes: number, affectedRoot: string): Promise<void> {
    const entries = await filesUnder(affectedRoot);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total + requiredBytes <= activeBudget) return;
    const evidence = orderOptionalEvidence(entries.flatMap((entry) => {
      const category = categoryFor(entry.relativePath);
      return category ? [{ runId: options.runId, relativePath: entry.relativePath, capturedAt: entry.capturedAt, category, size: entry.size }] : [];
    })).sort((a, b) => ["video", "trace", "screenshot"].indexOf(a.category) - ["video", "trace", "screenshot"].indexOf(b.category) || a.capturedAt - b.capturedAt || a.runId.localeCompare(b.runId) || a.relativePath.localeCompare(b.relativePath));
    for (const item of evidence) {
      if (total + requiredBytes <= activeBudget) break;
      await fs.rm(pathFor(item.relativePath), { force: true });
      total -= item.size;
    }
  }
  async function pruneGlobal(requiredBytes: number, target: string): Promise<void> {
    let entries = await filesUnder(globalRoot);
    let total = entries.reduce((sum, entry) => sum + (entry.absolutePath === target ? 0 : entry.size), 0);
    if (total + requiredBytes <= globalBudget) return;
    const evidence = orderOptionalEvidence(entries.flatMap((entry) => {
      const category = categoryFor(entry.relativePath);
      return category && entry.absolutePath !== target
        ? [{ runId: path.basename(path.dirname(entry.absolutePath)), relativePath: entry.relativePath, capturedAt: entry.capturedAt, category, size: entry.size, absolutePath: entry.absolutePath }]
        : [];
    })).sort((a, b) => ["video", "trace", "screenshot"].indexOf(a.category) - ["video", "trace", "screenshot"].indexOf(b.category) || a.capturedAt - b.capturedAt || a.runId.localeCompare(b.runId) || a.relativePath.localeCompare(b.relativePath));
    for (const item of evidence) {
      if (total + requiredBytes <= globalBudget) break;
      await fs.rm(item.absolutePath, { force: true });
      total -= item.size;
    }
  }
  return {
    async write(relativePath, bytes, kind) {
      await lock.withLock(async () => {
        const target = pathFor(relativePath);
        const payload = relativePath.toLowerCase().endsWith(".log") ? rotateTextLog(bytes) : bytes;
        await prune(payload.byteLength, root);
        const existing = await filesUnder(root);
        const current = existing.reduce((sum, entry) => sum + entry.size - (entry.absolutePath === target ? entry.size : 0), 0);
        if (current + payload.byteLength > activeBudget) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        if (current + payload.byteLength + REQUIRED_METADATA_RESERVATION_BYTES > activeBudget && !requiredKinds.has(kind)) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        await pruneGlobal(payload.byteLength, target);
        const globalEntries = await filesUnder(globalRoot);
        const globalTotal = globalEntries.reduce((sum, entry) => sum + (entry.absolutePath === target ? 0 : entry.size), 0);
        if (globalTotal + payload.byteLength > globalBudget) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        if (globalTotal + payload.byteLength + REQUIRED_METADATA_RESERVATION_BYTES > globalBudget && !requiredKinds.has(kind)) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        await writeAtomic(target, payload);
      });
    },
    async writeRequiredResult(metadata) {
      const encoded = encodeRequiredMetadata(metadata);
      if (!encoded.ok) {
        const bounded = createArtifactLimitFailure(metadata as never, { message: "required metadata exceeds reserved artifact space" });
        const replacement = encodeRequiredMetadata(bounded as unknown as Record<string, unknown>);
        if (!replacement.ok) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        await this.write("results.json", replacement.bytes, "result");
        return;
      }
      await this.write("results.json", encoded.bytes, "result");
    },
    async finalize(status) { await this.write("status.json", encodeUtf8(JSON.stringify({ status, terminalAt: clock() })), "status"); }
  };
}
