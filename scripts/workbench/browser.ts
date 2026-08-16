import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page
} from "playwright";
import { serializeWorkbenchUrl } from "../../src/workbench/url";
import {
  settleManagerQuery,
  WORKER_DISCOVERY_TIMEOUT_MS,
  WorkbenchCodedError
} from "./readiness";

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export interface WorkerGeneration {
  id: string;
  discoveredAt: string;
}

export interface ExtensionSession {
  context: BrowserContext;
  browser: Browser;
  extensionId: string;
  workerGenerations: WorkerGeneration[];
  openExtensionPage(pathname: string): Promise<Page>;
  terminateWorker(): Promise<{
    terminatedTargetId: string;
  }>;
  restartWorker(): Promise<{
    terminatedTargetId: string;
    awakenedTargetId: string;
  }>;
  close(): Promise<void>;
}

export type RunnerEvent = {
  source: "browser" | "worker" | "page";
  name: string;
  details?: Record<string, string | number | boolean>;
};

export function createChromiumLaunchOptions(
  buildPath: string,
  headless: boolean
) {
  const resolved = path.resolve(buildPath);
  return {
    channel: "chromium" as const,
    headless,
    args: [
      `--disable-extensions-except=${resolved}`,
      `--load-extension=${resolved}`
    ]
  };
}

export function parseExtensionWorkerUrl(workerUrl: string): string {
  const parsed = new URL(workerUrl);
  if (parsed.protocol !== "chrome-extension:")
    throw new Error("WORKBENCH_ARGUMENT: invalid extension worker URL");
  const extensionId = parsed.hostname;
  if (!EXTENSION_ID_PATTERN.test(extensionId))
    throw new Error("WORKBENCH_ARGUMENT: invalid extension id");
  return extensionId;
}

export function canonicalExtensionUrl(
  extensionId: string,
  entryPoint: string,
  mode: "fixture" | "real"
): string {
  const search = serializeWorkbenchUrl({
    workbench: true,
    mode,
    route: "groups",
    scenarioId: "wb:default",
    deepLink: "none",
    latencyMs: 0,
    failure: { mode: "none" }
  });
  return `chrome-extension://${extensionId}/${entryPoint}${search}`;
}

export function recordWorkerGeneration(
  generations: WorkerGeneration[],
  targetId: string,
  discoveredAt: string
): void {
  if (generations.some((generation) => generation.id === targetId)) return;
  generations.push({ id: targetId, discoveredAt });
}

export async function sendManagerQueryFromPage(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const chromeApi = (
      globalThis as {
        chrome?: {
          runtime?: {
            lastError?: { message?: string };
            sendMessage: (
              message: unknown,
              callback?: (response: unknown) => void
            ) => void;
          };
        };
      }
    ).chrome;
    if (!chromeApi?.runtime?.sendMessage)
      throw new Error("chrome.runtime.sendMessage unavailable");
    const runtime = chromeApi.runtime;
    return await new Promise((resolve, reject) => {
      runtime.sendMessage({ kind: "manager-query" }, (response) => {
        const lastError = runtime.lastError?.message;
        if (lastError) {
          reject(new Error(lastError));
          return;
        }
        resolve(response);
      });
    });
  });
}

function extensionPages(context: BrowserContext, extensionId: string): Page[] {
  return context
    .pages()
    .filter((page) =>
      page.url().startsWith(`chrome-extension://${extensionId}/`)
    );
}

async function discoverExtensionId(
  context: BrowserContext,
  timeoutMs = WORKER_DISCOVERY_TIMEOUT_MS
): Promise<string> {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return parseExtensionWorkerUrl(existing[0]!.url());
  try {
    const worker = await context.waitForEvent("serviceworker", {
      timeout: timeoutMs
    });
    return parseExtensionWorkerUrl(worker.url());
  } catch {
    throw new WorkbenchCodedError(
      "WORKBENCH_WORKER_TIMEOUT",
      "extension service worker was not discovered before the deadline",
      "worker"
    );
  }
}

async function listExtensionServiceWorkerTargets(
  browser: Browser
): Promise<Array<{ targetId: string; url: string }>> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const response = (await cdp.send("Target.getTargets")) as {
      targetInfos?: Array<{ targetId: string; type: string; url: string }>;
    };
    return (response.targetInfos ?? [])
      .filter(
        (target) =>
          target.type === "service_worker" &&
          target.url.startsWith("chrome-extension://")
      )
      .map((target) => ({ targetId: target.targetId, url: target.url }));
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function launchExtensionSession(input: {
  buildPath: string;
  profilePath: string;
  headless: boolean;
  onEvent?: (event: RunnerEvent) => Promise<void>;
}): Promise<ExtensionSession> {
  const launchOptions = createChromiumLaunchOptions(
    input.buildPath,
    input.headless
  );
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(
      input.profilePath,
      launchOptions
    );
    const browser = context.browser();
    if (!browser)
      throw new WorkbenchCodedError(
        "WORKBENCH_ARGUMENT",
        "persistent Chromium session has no browser handle",
        "argument"
      );

    const emit = async (event: RunnerEvent) => {
      if (input.onEvent) await input.onEvent(event);
    };

    context.on("console", (message) => {
      const url = message.location().url;
      const source =
        url.includes("background") || url.includes("service_worker")
          ? ("worker" as const)
          : ("page" as const);
      void emit({ source, name: "console", details: { text: message.text() } });
    });
    context.on("page", (page) => {
      page.on("pageerror", (error) => {
        void emit({
          source: "page",
          name: "pageerror",
          details: { message: error.message }
        });
      });
      page.on("crash", () => {
        void emit({
          source: "page",
          name: "crash",
          details: { url: page.url() }
        });
      });
    });

    const extensionId = await discoverExtensionId(context);
    await emit({
      source: "worker",
      name: "discovered",
      details: { extensionId }
    });

    const workerGenerations: WorkerGeneration[] = [];
    const targets = await listExtensionServiceWorkerTargets(browser);
    const initialTarget = targets.find(
      (target) => parseExtensionWorkerUrl(target.url) === extensionId
    );
    if (initialTarget)
      recordWorkerGeneration(
        workerGenerations,
        initialTarget.targetId,
        new Date().toISOString()
      );

    const terminateWorker = async (): Promise<{
      terminatedTargetId: string;
    }> => {
      const cdp = await browser.newBrowserCDPSession();
      try {
        const current = (await listExtensionServiceWorkerTargets(browser)).find(
          (target) => parseExtensionWorkerUrl(target.url) === extensionId
        );
        if (!current) {
          throw new WorkbenchCodedError(
            "WORKBENCH_WORKER_TIMEOUT",
            "no extension service worker target found",
            "restart-termination"
          );
        }
        const terminatedTargetId = current.targetId;
        await cdp.send("Target.closeTarget", {
          targetId: terminatedTargetId
        });
        // Parallel production-gate workers can delay CDP target bookkeeping.
        // Keep termination verification independent from a single manager read.
        const terminated = await waitUntil(async () => {
          const nextTargets = await listExtensionServiceWorkerTargets(browser);
          const targetStillPresent = nextTargets.some(
            (target) => target.targetId === terminatedTargetId
          );
          const workerStillAttached = context!
            .serviceWorkers()
            .some(
              (worker) => parseExtensionWorkerUrl(worker.url()) === extensionId
            );
          return !targetStillPresent || !workerStillAttached;
        }, WORKER_DISCOVERY_TIMEOUT_MS * 2);
        if (!terminated) {
          throw new WorkbenchCodedError(
            "WORKBENCH_WORKER_TIMEOUT",
            "extension service worker did not terminate before the deadline",
            "restart-termination"
          );
        }
        return { terminatedTargetId };
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    };

    return {
      context,
      browser,
      extensionId,
      workerGenerations,
      async openExtensionPage(pathname) {
        const page = await context!.newPage();
        await page.goto(`chrome-extension://${extensionId}/${pathname}`);
        return page;
      },
      terminateWorker,
      async restartWorker() {
        const { terminatedTargetId } = await terminateWorker();
        const page =
          extensionPages(context!, extensionId)[0] ??
          (await (async () => {
            const opened = await context!.newPage();
            await opened.goto(`chrome-extension://${extensionId}/options.html`);
            return opened;
          })());
        await settleManagerQuery({
          timeoutMs: WORKER_DISCOVERY_TIMEOUT_MS,
          request: () => sendManagerQueryFromPage(page)
        });

        let awakenedTarget: { targetId: string; url: string } | undefined;
        const awakened = await waitUntil(async () => {
          const nextTargets = await listExtensionServiceWorkerTargets(browser);
          awakenedTarget =
            nextTargets.find(
              (target) =>
                target.targetId !== terminatedTargetId &&
                parseExtensionWorkerUrl(target.url) === extensionId
            ) ??
            nextTargets.find(
              (target) => parseExtensionWorkerUrl(target.url) === extensionId
            );
          if (awakenedTarget) return true;
          return context!
            .serviceWorkers()
            .some(
              (worker) => parseExtensionWorkerUrl(worker.url()) === extensionId
            );
        }, WORKER_DISCOVERY_TIMEOUT_MS);
        if (!awakened) {
          throw new WorkbenchCodedError(
            "WORKBENCH_WORKER_TIMEOUT",
            "extension service worker did not wake before the deadline",
            "restart-wake"
          );
        }

        if (!awakenedTarget) {
          const worker = context!
            .serviceWorkers()
            .find(
              (candidate) =>
                parseExtensionWorkerUrl(candidate.url()) === extensionId
            );
          if (!worker) {
            throw new WorkbenchCodedError(
              "WORKBENCH_WORKER_TIMEOUT",
              "awakened service worker target missing",
              "restart-wake"
            );
          }
          awakenedTarget = {
            targetId: `${terminatedTargetId}-restarted`,
            url: worker.url()
          };
        }
        recordWorkerGeneration(
          workerGenerations,
          awakenedTarget.targetId,
          new Date().toISOString()
        );
        return {
          terminatedTargetId,
          awakenedTargetId: awakenedTarget.targetId
        };
      },
      async close() {
        await context!.close();
      }
    };
  } catch (error) {
    if (context) await context.close().catch(() => undefined);
    throw error;
  }
}
