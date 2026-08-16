import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export type BuildGraph = "workbench" | "production";

export interface BuildOutput {
  graph: BuildGraph;
  outDir: string;
  buildPath: string;
}

export function resolveBuildOutput(
  worktreePath: string,
  runId: string,
  graph: BuildGraph
): BuildOutput {
  const worktree = path.resolve(worktreePath);
  const outDir = path.join(worktree, ".workbench", "tmp", runId, graph);
  const buildPath = path.join(outDir, "chrome-mv3");
  return { graph, outDir, buildPath };
}

function resolveWxtInvocation(worktree: string): {
  command: string;
  prefixArgs: string[];
} {
  const wxtMjs = path.join(worktree, "node_modules", "wxt", "bin", "wxt.mjs");
  return { command: process.execPath, prefixArgs: [wxtMjs] };
}

function runCommand(
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> }
): Promise<void> {
  const { command, prefixArgs } = resolveWxtInvocation(options.cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefixArgs, ...args], {
      cwd: options.cwd,
      env: options.env as Record<string, string>,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`wxt exited with ${signal ?? code ?? "unknown status"}`)
        );
    });
  });
}

export async function buildExtension(input: {
  worktreePath: string;
  runId: string;
  graph: BuildGraph;
  productionE2e?: boolean;
}): Promise<BuildOutput> {
  const cwd = path.resolve(process.cwd());
  const worktree = path.resolve(input.worktreePath);
  if (worktree !== cwd)
    throw new Error("WORKBENCH_ARGUMENT: worktree must match process.cwd()");
  const output = resolveBuildOutput(worktree, input.runId, input.graph);
  await runCommand(["build", "-b", "chrome"], {
    cwd: worktree,
    env: {
      ...process.env,
      TABROUTE_WXT_OUT_DIR: output.outDir,
      TABROUTE_WORKBENCH: input.graph === "workbench" ? "1" : "0",
      TABROUTE_PRODUCTION_E2E:
        input.graph === "production" && input.productionE2e ? "1" : "0"
    }
  });
  try {
    await access(output.buildPath);
  } catch {
    throw new Error("WORKBENCH_ARGUMENT: chrome-mv3 build output missing");
  }
  return output;
}
