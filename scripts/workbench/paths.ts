import os from "node:os";
import path from "node:path";
import type { RunPaths } from "./contracts";

export function assertPathWithin(rootPath: string, candidatePath: string): string {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new Error("WORKBENCH_PATH_BOUNDARY");
  return candidate;
}

export function resolveRunPaths(worktreePath: string, runId: string, profilePath = path.join(os.tmpdir(), "tabroute-workbench", runId)): RunPaths {
  const root = path.resolve(worktreePath);
  if (!runId || runId.includes("/") || runId.includes("\\") || runId === "." || runId === "..") throw new Error("WORKBENCH_ARGUMENT");
  const buildPath = path.join(root, ".workbench", "tmp", runId, "production", "chrome-mv3");
  const artifactPath = path.join(root, ".workbench", "artifacts", runId);
  assertPathWithin(root, buildPath);
  assertPathWithin(root, artifactPath);
  return { runId, worktreePath: root, buildPath, profilePath: path.resolve(profilePath), artifactPath };
}

export function isOwnedProfilePath(profilePath: string | undefined, profileRoot: string, runId: string, worktreePath?: string): profilePath is string {
  if (!profilePath || !path.isAbsolute(profilePath) || !runId || runId.includes("/") || runId.includes("\\")) return false;
  const root = path.resolve(profileRoot);
  const candidate = path.resolve(profilePath);
  const worktree = worktreePath ? path.resolve(worktreePath) : undefined;
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`) || candidate === worktree || (worktree && candidate.startsWith(`${worktree}${path.sep}`))) return false;
  const name = path.basename(candidate);
  return name === runId || name === `profile-${runId}`;
}

export function assertOwnedProfilePath(profilePath: string | undefined, profileRoot: string, runId: string, worktreePath?: string): string {
  if (!isOwnedProfilePath(profilePath, profileRoot, runId, worktreePath)) throw new Error("WORKBENCH_PATH_BOUNDARY");
  return path.resolve(profilePath);
}

export function resolveArtifactPath(artifactRoot: string, relativePath: string): string {
  return assertPathWithin(artifactRoot, path.resolve(artifactRoot, relativePath));
}
