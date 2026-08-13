import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export type CliDispatch =
  | { command: "build-workbench"; action: "build"; graph: "workbench" }
  | { command: "workbench"; action: "run"; graph: "workbench"; mode: "fixture" | "real"; entryPoint: "options.html"; scenario: "wb:default"; once: boolean }
  | { command: "test-workbench" | "test-extension" | "smoke-popup"; action: "playwright"; spec: string };

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`WORKBENCH_ARGUMENT: ${name} requires a value`);
  return value;
}

export function parseCliDispatch(args: readonly string[]): CliDispatch {
  const command = args.find((argument) => !argument.startsWith("--"));
  if (command === "build-workbench")
    return { command, action: "build", graph: "workbench" };
  if (command === "workbench") {
    const mode = option(args, "--mode");
    if (mode !== "fixture" && mode !== "real")
      throw new Error("WORKBENCH_ARGUMENT: workbench requires --mode fixture or --mode real");
    return {
      command,
      action: "run",
      graph: "workbench",
      mode,
      entryPoint: "options.html",
      scenario: "wb:default",
      once: args.includes("--once")
    };
  }
  if (command === "test-workbench")
    return { command, action: "playwright", spec: "tests/e2e/workbench.spec.ts" };
  if (command === "test-extension")
    return { command, action: "playwright", spec: "tests/e2e/extension.spec.ts" };
  if (command === "smoke-popup")
    return { command, action: "playwright", spec: "tests/e2e/popup-smoke.spec.ts" };
  throw new Error(`WORKBENCH_ARGUMENT: unsupported command ${command ?? "<missing>"}`);
}

async function runPlaywright(spec: string): Promise<void> {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["exec", "playwright", "test", spec], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Playwright exited with ${signal ?? code ?? "unknown status"}`));
    });
  });
}

export async function executeCliDispatch(dispatch: CliDispatch): Promise<void> {
  if (dispatch.action === "build") {
    const { buildExtension } = await import("./build");
    const runId = `build-${crypto.randomUUID()}`;
    const result = await buildExtension({ worktreePath: process.cwd(), runId, graph: dispatch.graph });
    process.stdout.write(`${result.buildPath}\n`);
    return;
  }
  if (dispatch.action === "run") {
    const { runWorkbench } = await import("./runner");
    const result = await runWorkbench({
      worktreePath: process.cwd(),
      mode: dispatch.mode,
      entryPoint: dispatch.entryPoint,
      scenario: dispatch.scenario,
      once: dispatch.once,
      headless: dispatch.once
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  await runPlaywright(dispatch.spec);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const contractMode = args.includes("--contract");
  const dispatch = parseCliDispatch(args.filter((argument) => argument !== "--contract"));
  if (contractMode) {
    process.stdout.write(`${JSON.stringify(dispatch)}\n`);
    return;
  }
  await executeCliDispatch(dispatch);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
