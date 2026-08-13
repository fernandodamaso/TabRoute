import { promises as fs } from "node:fs";
import path from "node:path";
import { createArtifactLimitFailure, capRunMetadata, REQUIRED_METADATA_RESERVATION_BYTES, type ArtifactKind, type ArtifactLimitSource, type ArtifactStore } from "./contracts";
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

export function encodeRequiredMetadata<T extends object>(metadata: T, reservationBytes = REQUIRED_METADATA_RESERVATION_BYTES): { ok: true; bytes: Uint8Array; value: T } | { ok: false; bytes: Uint8Array; value: T } {
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

async function filesUnder(root: string): Promise<Array<{ absolutePath: string; relativePath: string; size: number; capturedAt: number }>> {
  const entries: Array<{ absolutePath: string; relativePath: string; size: number; capturedAt: number }> = [];
  async function visit(directory: string): Promise<void> {
    let children: import("node:fs").Dirent[];
    try { children = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === root) return;
      throw new Error("WORKBENCH_ARTIFACT_LIMIT");
    }
    for (const child of children) {
      if (child.name === ".lock" || child.name === ".lock.guard") continue;
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

export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore & { writeRequiredResult<T extends ArtifactLimitSource>(metadata: T): Promise<void> } {
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
  // The index is an optional pruning aid. It is part of the ordinary budget,
  // but never consumes the shared required-metadata reservation.
  const requiredNames = new Set(["lease.json", "status.json", "results.json", "error.json"]);
  const isRequiredPath = (relativePath: string): boolean => requiredNames.has(relativePath.replaceAll("\\", "/"));
  const isRequiredEntry = (relativePath: string): boolean => !relativePath.replaceAll("\\", "/").includes("/") && requiredNames.has(relativePath.replaceAll("\\", "/"));
  async function readIndex(runRoot: string): Promise<Array<{ relativePath: string; kind: ArtifactKind; capturedAt: number }>> {
    try { return JSON.parse(await fs.readFile(indexPath(runRoot), "utf8")) as Array<{ relativePath: string; kind: ArtifactKind; capturedAt: number }>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("WORKBENCH_ARTIFACT_LIMIT"); }
  }
  async function writeIndex(runRoot: string, entries: Array<{ relativePath: string; kind: ArtifactKind; capturedAt: number }>): Promise<void> {
    await writeAtomic(indexPath(runRoot), encodeUtf8(JSON.stringify(entries.slice(0, 2000))));
  }
  const requiredBytes = async (directory: string, target?: string): Promise<number> => {
    const entries = await filesUnder(directory);
    return entries.reduce((sum, entry) => sum + (isRequiredEntry(entry.relativePath) && entry.absolutePath !== target ? entry.size : 0), 0);
  };
  async function isTerminalRun(runRoot: string): Promise<boolean> {
    try {
      const status = JSON.parse(await fs.readFile(path.join(runRoot, "status.json"), "utf8")) as { status?: string };
      return status.status === "completed" || status.status === "failed" || status.status === "abandoned";
    } catch { return false; }
  }
  async function globalRequiredHeadroom(affectedRequiredAfter: number): Promise<number> {
    if (root === globalRoot) return Math.max(0, REQUIRED_METADATA_RESERVATION_BYTES - affectedRequiredAfter);
    let directories: import("node:fs").Dirent[] = [];
    try { directories = await fs.readdir(globalRoot, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("WORKBENCH_ARTIFACT_LIMIT"); }
    const runRoots = new Set(directories.filter((entry) => entry.isDirectory() && entry.name !== ".lock.guard").map((entry) => path.resolve(globalRoot, entry.name)));
    runRoots.add(root);
    let headroom = 0;
    for (const runRoot of runRoots) {
      if (await isTerminalRun(runRoot)) continue;
      const bytes = runRoot === root ? affectedRequiredAfter : await requiredBytes(runRoot);
      headroom += Math.max(0, REQUIRED_METADATA_RESERVATION_BYTES - bytes);
    }
    return headroom;
  }
  async function prune(requiredCapacity: number, affectedRoot: string, target: string): Promise<void> {
    const entries = await filesUnder(affectedRoot);
    let total = entries.reduce((sum, entry) => sum + (path.basename(entry.absolutePath) === ".lock" || entry.absolutePath === target ? 0 : entry.size), 0);
    if (total + requiredCapacity <= activeBudget) return;
    const indexed = await readIndex(affectedRoot);
    const evidence = orderRetentionEvidence(indexed.filter((item) => item.kind === "video" || item.kind === "trace" || item.kind === "screenshot").map((item) => ({ ...item, runId: options.runId, category: item.kind as EvidenceCategory })));
    const sizes = new Map(entries.map((entry) => [entry.relativePath.replaceAll("\\", "/"), entry.size]));
    for (const item of evidence) {
      if (total + requiredCapacity <= activeBudget) break;
      if (pathFor(item.relativePath) === target) continue;
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
  async function pruneGlobal(requiredCapacity: number, target: string): Promise<void> {
    const entries = await filesUnder(globalRoot);
    let total = entries.reduce((sum, entry) => sum + (entry.absolutePath === target || path.basename(entry.absolutePath) === ".lock" ? 0 : entry.size), 0);
    if (total + requiredCapacity <= globalBudget) return;
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
      if (total + requiredCapacity <= globalBudget) break;
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
        const affectedRequiredBefore = await requiredBytes(root, target);
        const affectedRequiredAfter = affectedRequiredBefore + (isRequiredPath(relativePath) ? payload.byteLength : 0);
        if (affectedRequiredAfter > REQUIRED_METADATA_RESERVATION_BYTES) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        const affectedHeadroom = REQUIRED_METADATA_RESERVATION_BYTES - affectedRequiredAfter;
        const globalHeadroom = await globalRequiredHeadroom(affectedRequiredAfter);
        const preExisting = await filesUnder(root);
        const preIndex = isRequiredPath(relativePath) ? undefined : [...(await readIndex(root)).filter((item) => item.relativePath !== relativePath), { relativePath, kind, capturedAt: writeOptions.capturedAt ?? clock() }];
        const preOldIndexSize = preExisting.find((entry) => path.basename(entry.absolutePath) === ".artifact-index.json")?.size ?? 0;
        const preIndexSizeDelta = preIndex ? encodeUtf8(JSON.stringify(preIndex.slice(0, 2000))).byteLength - preOldIndexSize : 0;
        await prune(payload.byteLength + preIndexSizeDelta + affectedHeadroom, root, target);
        const existing = await filesUnder(root);
        const current = existing.reduce((sum, entry) => sum + (path.basename(entry.absolutePath) === ".lock" ? 0 : entry.size - (entry.absolutePath === target ? entry.size : 0)), 0);
        const nextIndex = isRequiredPath(relativePath) ? undefined : [...(await readIndex(root)).filter((item) => item.relativePath !== relativePath), { relativePath, kind, capturedAt: writeOptions.capturedAt ?? clock() }];
        const oldIndexSize = existing.find((entry) => path.basename(entry.absolutePath) === ".artifact-index.json")?.size ?? 0;
        const indexSizeDelta = nextIndex ? encodeUtf8(JSON.stringify(nextIndex.slice(0, 2000))).byteLength - oldIndexSize : 0;
        const writeSize = payload.byteLength + indexSizeDelta;
        if (current + writeSize + affectedHeadroom > activeBudget) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        await pruneGlobal(writeSize + globalHeadroom, target);
        const globalEntries = await filesUnder(globalRoot);
        const globalTotal = globalEntries.reduce((sum, entry) => sum + (entry.absolutePath === target || path.basename(entry.absolutePath) === ".lock" ? 0 : entry.size), 0);
        if (globalTotal + writeSize + globalHeadroom > globalBudget) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
        await writeAtomic(target, payload);
        if (nextIndex) await writeIndex(root, nextIndex);
      });
    },
    async writeRequiredResult(metadata) {
      const encoded = encodeRequiredMetadata(metadata);
      if (encoded.ok) {
        try {
          await this.write("results.json", encoded.bytes, "result");
          return;
        } catch (error) {
          if ((error as Error).message !== "WORKBENCH_ARTIFACT_LIMIT") throw error;
        }
      }
      const bounded = createArtifactLimitFailure(metadata, { message: "required metadata exceeds reserved artifact space" });
      const replacement = encodeRequiredMetadata(bounded);
      if (!replacement.ok) throw new Error("WORKBENCH_ARTIFACT_LIMIT");
      await this.write("results.json", replacement.bytes, "result");
    },
    async finalize(status) {
      await this.write("status.json", encodeUtf8(JSON.stringify({ status, terminalAt: clock() })), "status");
      await lock.withLock(async () => { await pruneTerminalRuns(""); });
    }
  };
}
