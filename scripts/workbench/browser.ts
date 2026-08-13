import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { serializeWorkbenchUrl } from "../../src/workbench/url";
import {
  MANAGER_QUERY_TIMEOUT_MS,
  settleManagerQuery,
  WORKER_DISCOVERY_TIMEOUT_MS
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
  restartWorker(): Promise<{ terminatedTargetId: string; awakenedTargetId: string }>;
  close(): Promise<void>;
}

export type RunnerEvent = {
  source: "browser" | "worker" | "page";
  name: string;
  details?: Record<string, string | number | boolean>;
};

export function createChromiumLaunchOptions(buildPath: string, headless: boolean) {
  const resolved = path.resolve(buildPath);
  return {
    channel: "chromium" as const,
    headless,
    args: [`--disable-extensions-except=${resolved}`, `--load-extension=${resolved}`]
  };
}

export function parseExtensionWorkerUrl(workerUrl: string): string {
  const parsed = new URL(workerUrl);
  if (parsed.protocol !== "chrome-extension:") throw new Error("WORKBENCH_ARGUMENT: invalid extension worker URL");
  const extensionId = parsed.hostname;
  if (!EXTENSION_ID_PATTERN.test(extensionId)) throw new Error("WORKBENCH_ARGUMENT: invalid extension id");
  return extensionId;
}

export function canonicalExtensionUrl(extensionId: string, entryPoint: string, mode: "fixture" | "real"): string {
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

async function discoverExtensionId(context: BrowserContext, timeoutMs = WORKER_DISCOVERY_TIMEOUT_MS): Promise<string> {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return parseExtensionWorkerUrl(existing[0].url());
  try {
    const worker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
    return parseExtensionWorkerUrl(worker.url());
  } catch {
    throw new Error("WORKBENCH_WORKER_TIMEOUT: extension service worker was not discovered before the deadline");
  }
}

async function listExtensionServiceWorkerTargets(browser: Browser): Promise<Array<{ targetId: string; url: string }>> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const response = await cdp.send("Target.getTargets") as { targetInfos?: Array<{ targetId: string; type: string; url: string }> };
    return (response.targetInfos ?? [])
      .filter((target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"))
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
  const launchOptions = createChromiumLaunchOptions(input.buildPath, input.headless);
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(input.profilePath, launchOptions);
    const browser = context.browser();
    if (!browser) throw new Error("WORKBENCH_ARGUMENT: persistent Chromium session has no browser handle");

    const emit = async (event: RunnerEvent) => {
      if (input.onEvent) await input.onEvent(event);
    };

    context.on("console", (message) => {
      void emit({ source: "page", name: "console", details: { text: message.text() } });
    });
    context.on("page", (page) => {
      page.on("pageerror", (error) => {
        void emit({ source: "page", name: "pageerror", details: { message: error.message } });
      });
    });

    const extensionId = await discoverExtensionId(context);
    await emit({ source: "worker", name: "discovered", details: { extensionId } });

    const workerGenerations: WorkerGeneration[] = [];
    const targets = await listExtensionServiceWorkerTargets(browser);
    const initialTarget = targets.find((target) => parseExtensionWorkerUrl(target.url) === extensionId);
    if (initialTarget) recordWorkerGeneration(workerGenerations, initialTarget.targetId, new Date().toISOString());

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
      async restartWorker() {
        const cdp = await browser.newBrowserCDPSession();
        try {
          const targets = await listExtensionServiceWorkerTargets(browser);
          const current = targets.find((target) => parseExtensionWorkerUrl(target.url) === extensionId);
          if (!current) throw new Error("WORKBENCH_WORKER_TIMEOUT: no extension service worker target found");
          const terminatedTargetId = current.targetId;
          await cdp.send("Target.closeTarget", { targetId: terminatedTargetId });
          const terminated = await waitUntil(async () => {
            const nextTargets = await listExtensionServiceWorkerTargets(browser);
            return !nextTargets.some((target) => target.targetId === terminatedTargetId);
          }, MANAGER_QUERY_TIMEOUT_MS);
          if (!terminated) throw new Error("WORKBENCH_WORKER_TIMEOUT: restart-termination deadline exceeded");

          const page = await context!.newPage();
          try {
            await settleManagerQuery({
              timeoutMs: MANAGER_QUERY_TIMEOUT_MS,
              request: () => page.evaluate(async () => {
                const chromeApi = (globalThis as { chrome?: { runtime?: { sendMessage: (message: unknown) => Promise<unknown> } } }).chrome;
                if (!chromeApi?.runtime?.sendMessage) throw new Error("chrome.runtime.sendMessage unavailable");
                return chromeApi.runtime.sendMessage({ kind: "manager-query" });
              })
            });
          } finally {
            await page.close();
          }

          const awakened = await waitUntil(async () => {
            const nextTargets = await listExtensionServiceWorkerTargets(browser);
            return nextTargets.some((target) => target.targetId !== terminatedTargetId && parseExtensionWorkerUrl(target.url) === extensionId);
          }, MANAGER_QUERY_TIMEOUT_MS);
          if (!awakened) throw new Error("WORKBENCH_WORKER_TIMEOUT: restart-wake deadline exceeded");

          const awakenedTarget = (await listExtensionServiceWorkerTargets(browser))
            .find((target) => target.targetId !== terminatedTargetId && parseExtensionWorkerUrl(target.url) === extensionId);
          if (!awakenedTarget) throw new Error("WORKBENCH_WORKER_TIMEOUT: awakened service worker target missing");
          recordWorkerGeneration(workerGenerations, awakenedTarget.targetId, new Date().toISOString());
          return { terminatedTargetId, awakenedTargetId: awakenedTarget.targetId };
        } finally {
          await cdp.detach().catch(() => undefined);
        }
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
