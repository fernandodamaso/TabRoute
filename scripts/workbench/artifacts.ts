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
export const orderRetentionEvidence = <T extends OptionalEvidence>(items: readonly T[]): T[] => [...items].sort((a, b) => ["video", "trace", "screenshot"].indexOf(a.category) - ["video", "trace", "screenshot"].indexOf(b.category) || a.capturedAt - b.capturedAt || a.runId.localeCompare(b.runId) || a.relativePath.localeCompare(b.relativePath));
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
async function filesUnder(root: string): Promise<Array<{ absolutePath: string; relativePath: string; size: number; capturedAt: number }>> {
  const entries: Array<{ absolutePath: string; relativePath: string; size: number; capturedAt: number }> = [];
  async function visit(directory: string): Promise<void> {
    let children: import("node:fs").Dirent[];
    try { children = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === root) return;
      throw new Error("WORKBENCH_ARTIFACT_LIMIT");
    }
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
  const lock = createCrossProcessLock(path.join(globalRoot, ".lock"), { runId: options.runId, failureCode: "WORKBENCH_ARTIFACT_LIMIT" });
  const activeBudget = options.activeBudgetBytes ?? ACTIVE_RUN_BUDGET_BYTES;
  const globalBudget = options.globalBudgetBytes ?? GLOBAL_BUDGET_BYTES;
  const clock = options.clock ?? Date.now;
  const pathFor = (relativePath: string) => {
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("artifact path escapes run root");
    return target;
  };
  const indexPath = (runRoot: string) => path.join(runRoot, ".artifact-index.json");
  const requiredNames = new Set(["lease.json", "status.json", "results.json", "error.json", ".artifact-index.json"]);
  async function readIndex(runRoot: string): Promise<Array<{ relativePath: string; kind: ArtifactKind; capturedAt: number }>> {
    try { return JSON.parse(await fs.readFile(indexPath(runRoot), "utf8")) as Array<{ relativePath: string; kind: ArtifactKind; capturedAt: number }>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("WORKBENCH_ARTIFACT_LIMIT"); }
  }
  async function writeIndex(runRoot: string, entries: Array<{ relativePath: string; kind: ArtifactKind; capturedAt: number }>): Promise<void> {
    await writeAtomic(indexPath(runRoot), encodeUtf8(JSON.stringify(entries.slice(0, 2000))));
  }
  async function prune(requiredBytes: number, affectedRoot: string): Promise<void> {
    const entries = await filesUnder(affectedRoot);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total + requiredBytes <= activeBudget) return;
    const indexed = await readIndex(affectedRoot);
    const evidence = orderRetentionEvidence(indexed.filter((item) => item.kind === "video" || item.kind === "trace" || item.kind === "screenshot").map((item) => ({ ...item, runId: options.runId, category: item.kind as EvidenceCategory })));
    const sizes = new Map(entries.map((entry) => [entry.relativePath.replaceAll("\\", "/"), entry.size]));
    for (const item of evidence) {
      if (total + requiredBytes <= activeBudget) break;
      const size = sizes.get(item.relativePath.replaceAll("\\", "/")) ?? 0;
      await fs.rm(pathFor(item.relativePath), { force: true });
      total -= size;
    }
  }
  async function pruneTerminalRuns(excludeRunId = options.runId): Promise<void> {
    let dirs: import("node:fs").Dirent[];
    try { dirs = await fs.readdir(globalRoot, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("WORKBENCH_ARTIFACT_LIMIT"); }
    const now = clock();
    const terminal: Array<{ runId: string; terminalAt: number }> = [];
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name === ".lock" || dir.name === excludeRunId) continue;
      try {
        const status = JSON.parse(await fs.readFile(path.join(globalRoot, dir.name, "status.json"), "utf8")) as { status?: string; terminalAt?: number };
        if (["completed", "failed", "abandoned"].includes(status.status ?? "") && typeof status.terminalAt === "number") terminal.push({ runId: dir.name, terminalAt: status.terminalAt });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("WORKBENCH_ARTIFACT_LIMIT"); }
    }
    for (const run of orderTerminalRuns(terminal.filter((item) => now - item.terminalAt > TERMINAL_RUN_RETENTION_MS))) await fs.rm(path.join(globalRoot, run.runId), { recursive: true, force: true });
    const remaining = orderTerminalRuns(terminal.filter((item) => now - item.terminalAt <= TERMINAL_RUN_RETENTION_MS));
    for (const run of remaining.slice(0, Math.max(0, remaining.length - TERMINAL_RUN_LIMIT))) await fs.rm(path.join(globalRoot, run.runId), { recursive: true, force: true });
  }
  async function pruneGlobal(requiredBytes: number, target: string): Promise<void> {
    const entries = await filesUnder(globalRoot);
    let total = entries.reduce((sum, entry) => sum + (entry.absolutePath === target || path.basename(entry.absolutePath) === ".lock" ? 0 : entry.size), 0);
    if (total + requiredBytes <= globalBudget) return;
    const evidence: Array<OptionalEvidence & { size: number; absolutePath: string }> = [];
    for (const entry of entries) {
      const relative = path.relative(globalRoot, entry.absolutePath).replaceAll("\\", "/");
      const [runId, ...parts] = relative.split("/");
      if (!runId || parts.length === 0) continue;
      const runRoot = path.join(globalRoot, runId);
      const runRelativePath = parts.join("/");
      const index = await readIndex(runRoot);
      const item = index.find((candidate) => candidate.relativePath.replaceAll("\\", "/") === runRelativePath && (candidate.kind === "video" || candidate.kind === "trace" || candidate.kind === "screenshot"));
      if (item && entry.absolutePath !== target && path.basename(entry.absolutePath) !== ".lock") evidence.push({ runId, relativePath: runRelativePath, capturedAt: item.capturedAt, category: item.kind as EvidenceCategory, size: entry.size, absolutePath: entry.absolutePath });
    }
    evidence.splice(0, evidence.length, ...orderRetentionEvidence(evidence));
    for (const item of evidence) {
      if (total + requiredBytes <= globalBudget) break;
      await fs.rm(item.absolutePath, { force: true });
      total -= item.size;
    }
  }
  return {
    async write(relativePath, bytes, kind, writeOptions = {}) {
      await lock.withLock(async () => {
        const target = pathFor(relativePath);
        const payload = relativePath.toLowerCase().endsWith(".log") ? rotateTextLog(bytes) : bytes;
        await pruneTerminalRuns();
        await prune(payload.byteLength, root);
        const existing = await filesUnder(root);
        const current = existing.reduce((sum, entry) => sum + entry.size - (entry.absolutePath === target ? entry.size : 0), 0);
        const nextIndex = requiredNames.has(path.basename(relativePath)) ? undefined : [...(await readIndex(root)).filter((item) => item.relativePath !== relativePath), { relativePath, kind, capturedAt: writeOptions.capturedAt ?? clock() }];
        const oldIndexSize = existing.find((entry) => path.basename(entry.absolutePath) === ".artifact-index.json")?.size ?? 0;
        const indexSizeDelta = nextIndex ? encodeUtf8(JSON.stringify(nextIndex.slice(0, 2000))).byteLength - oldIndexSize : 0;
        const writeSize = payload.byteLength + indexSizeDelta;
        if (current + writeSize > activeBudget) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        if (current + writeSize + REQUIRED_METADATA_RESERVATION_BYTES > activeBudget && !requiredKinds.has(kind)) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        await pruneGlobal(writeSize + (requiredKinds.has(kind) ? 0 : REQUIRED_METADATA_RESERVATION_BYTES), target);
        const globalEntries = await filesUnder(globalRoot);
        const globalTotal = globalEntries.reduce((sum, entry) => sum + (entry.absolutePath === target || path.basename(entry.absolutePath) === ".lock" ? 0 : entry.size), 0);
        if (globalTotal + writeSize > globalBudget) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        if (globalTotal + writeSize + REQUIRED_METADATA_RESERVATION_BYTES > globalBudget && !requiredKinds.has(kind)) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        await writeAtomic(target, payload);
        if (nextIndex) await writeIndex(root, nextIndex);
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
    async finalize(status) {
      await this.write("status.json", encodeUtf8(JSON.stringify({ status, terminalAt: clock() })), "status");
      await lock.withLock(async () => { await pruneTerminalRuns(""); });
    }
  };
}
