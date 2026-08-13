import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export type CliDispatch =
  | { command: "build-workbench"; action: "build"; graph: "workbench" }
  | {
      command: "workbench";
      action: "run";
      graph: "workbench";
      mode: "fixture" | "real";
      entryPoint: "options.html";
      scenario: "wb:default";
      once: boolean;
    }
  | {
      command: "test-workbench" | "smoke-popup";
      action: "playwright";
      spec: string;
    }
  | { command: "test-extension"; action: "production-gate" };

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`WORKBENCH_ARGUMENT: ${name} requires a value`);
  return value;
}

export function parseCliDispatch(args: readonly string[]): CliDispatch {
  const command = args.find((argument) => !argument.startsWith("--"));
  if (command === "build-workbench")
    return { command, action: "build", graph: "workbench" };
  if (command === "workbench") {
    const mode = option(args, "--mode");
    if (mode !== "fixture" && mode !== "real")
      throw new Error(
        "WORKBENCH_ARGUMENT: workbench requires --mode fixture or --mode real"
      );
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
    return {
      command,
      action: "playwright",
      spec: "tests/e2e/workbench.spec.ts"
    };
  if (command === "test-extension")
    return { command, action: "production-gate" };
  if (command === "smoke-popup")
    return {
      command,
      action: "playwright",
      spec: "tests/e2e/popup-smoke.spec.ts"
    };
  throw new Error(
    `WORKBENCH_ARGUMENT: unsupported command ${command ?? "<missing>"}`
  );
}

export const PRODUCTION_GATE_SPECS = [
  "tests/e2e/extension.spec.ts",
  "tests/e2e/lifecycle.spec.ts",
  "tests/e2e/startup.spec.ts"
] as const;

async function runPlaywright(
  specs: string | string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const specArgs = Array.isArray(specs) ? specs : [specs];
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["playwright", "test", ...specArgs], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Playwright exited with ${signal ?? code ?? "unknown status"}`
          )
        );
    });
  });
}

export async function executeCliDispatch(dispatch: CliDispatch): Promise<void> {
  if (dispatch.action === "build") {
    const { buildExtension } = await import("./build");
    const runId = `build-${crypto.randomUUID()}`;
    const result = await buildExtension({
      worktreePath: process.cwd(),
      runId,
      graph: dispatch.graph
    });
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
  if (dispatch.action === "production-gate") {
    const { runProductionGate } = await import("./runner");
    const gate = await runProductionGate(process.cwd());
    await runPlaywright([...PRODUCTION_GATE_SPECS], {
      ...process.env,
      TABROUTE_PRODUCTION_BUILD_PATH: gate.productionBuildPath,
      TABROUTE_PRODUCTION_GATE_RESULT_PATH: gate.resultPath
    });
    return;
  }
  if (dispatch.command === "smoke-popup") {
    const { buildExtension } = await import("./build");
    const { scanProductionBuild } = await import("./production-scan");
    const runId = `popup-smoke-${crypto.randomUUID()}`;
    const build = await buildExtension({
      worktreePath: process.cwd(),
      runId,
      graph: "production"
    });
    const scan = await scanProductionBuild(build.buildPath);
    if (!scan.ok) throw new Error(scan.errors.join("; "));
    await runPlaywright(dispatch.spec, {
      ...process.env,
      TABROUTE_PRODUCTION_BUILD_PATH: build.buildPath
    });
    return;
  }
  await runPlaywright(dispatch.spec);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const contractMode = args.includes("--contract");
  const dispatch = parseCliDispatch(
    args.filter((argument) => argument !== "--contract")
  );
  if (contractMode) {
    process.stdout.write(`${JSON.stringify(dispatch)}\n`);
    return;
  }
  await executeCliDispatch(dispatch);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
