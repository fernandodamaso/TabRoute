// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import {
  registerCommands,
  resetCommandRegistrationForTests
} from "../../src/background/registerCommands";
import {
  registerMenus,
  resetMenuRegistrationForTests,
  type MenuCommandHost,
  type MenuContext
} from "../../src/background/registerMenus";
import { ManagerApp } from "../../src/ui/manager/ManagerApp";
import type {
  ManagerResponse,
  ManagerViewMetadata
} from "../../src/ui/manager/types";

const view = {
  width: 520,
  height: 600,
  headerHeight: 52,
  navigationHeight: 42,
  defaultRoute: "groups",
  routes: ["groups", "rules", "activity", "settings"] as const
} satisfies ManagerViewMetadata;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function eventTarget<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener(listener: (...args: T) => void) {
      listeners.add(listener);
    },
    listenerCount() {
      return listeners.size;
    },
    async emit(...args: T) {
      await Promise.all(
        [...listeners].map((listener) => Promise.resolve(listener(...args)))
      );
    }
  };
}

function emptyMenuContext(): MenuContext {
  return {
    configuration: createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    ),
    inventory: {
      capturedAt: 1,
      windows: [],
      tabs: [],
      groups: []
    },
    associations: [],
    checkpointInFlight: false
  };
}

function menuBrowser() {
  const clicked =
    eventTarget<
      [chrome.contextMenus.OnClickData, chrome.tabs.Tab | undefined]
    >();
  const browser = {
    contextMenus: {
      onClicked: clicked,
      removeAll: vi.fn(async () => undefined),
      create: vi.fn(
        (
          props: chrome.contextMenus.CreateProperties,
          callback?: () => void
        ) => {
          callback?.();
          return String(props.id ?? "generated");
        }
      )
    },
    runtime: {
      lastError: undefined
    }
  } as unknown as typeof chrome;
  return { browser, clicked };
}

function commandBrowser() {
  const commands = eventTarget<[string, chrome.tabs.Tab | undefined]>();
  const browser = {
    commands: { onCommand: commands },
    tabs: {
      query: vi.fn(async () => [
        {
          id: 10,
          windowId: 1,
          url: "https://example.com/",
          incognito: false
        }
      ])
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: vi.fn(async () => ({
        id: 1,
        incognito: false,
        type: "normal"
      }))
    }
  } as unknown as typeof chrome;
  return { browser, commands };
}

function contextWithTab(): MenuContext {
  const context = emptyMenuContext();
  return {
    ...context,
    inventory: {
      ...context.inventory,
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 10,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://example.com/",
          status: "complete",
          title: "Example",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 1
        }
      ]
    }
  };
}

function configurationWithWork() {
  return createManagedGroup(
    createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001"),
    { name: "Work", color: "blue" },
    () => "00000000-0000-4000-8000-000000000002",
    () => 2
  );
}

describe("FDM-738 MV3 startup readiness", () => {
  beforeEach(() => {
    resetMenuRegistrationForTests();
    resetCommandRegistrationForTests();
    vi.restoreAllMocks();
  });

  it("attaches the context-menu click listener before async menu materialization settles", async () => {
    const pendingContext = deferred<MenuContext>();
    const { browser, clicked } = menuBrowser();
    const executeUserCommand = vi.fn(async () => ({ ok: true as const }));
    const host: MenuCommandHost = {
      executeUserCommand,
      readMenuContext: vi.fn(() => pendingContext.promise)
    };

    const registration = registerMenus(browser, host);

    expect(clicked.listenerCount()).toBe(1);

    const click = clicked.emit(
      { menuItemId: "tabroute:move-other", editable: false },
      {
        id: 10,
        windowId: 1,
        url: "https://example.com/",
        incognito: false
      } as chrome.tabs.Tab
    );
    await Promise.resolve();
    expect(executeUserCommand).not.toHaveBeenCalled();

    pendingContext.resolve(contextWithTab());
    await Promise.all([registration, click]);
    expect(executeUserCommand).toHaveBeenCalledWith({
      kind: "moveToOther",
      tabId: 10
    });
  });

  it("waits for readiness before executing a manifest command", async () => {
    const pendingContext = deferred<MenuContext>();
    const { browser, commands } = commandBrowser();
    const executeUserCommand = vi.fn(async () => ({ ok: true as const }));
    const host: MenuCommandHost = {
      executeUserCommand,
      readMenuContext: vi.fn(() => pendingContext.promise)
    };

    registerCommands(browser, host);
    const command = commands.emit("toggle-automation", undefined);
    await Promise.resolve();
    expect(executeUserCommand).not.toHaveBeenCalled();

    pendingContext.resolve(emptyMenuContext());
    await command;
    expect(executeUserCommand).toHaveBeenCalledWith({
      kind: "toggleAutomation"
    });
  });

  it("registers wake-critical background listeners before async startup begins", () => {
    const source = readFileSync(
      join(process.cwd(), "entrypoints/background.ts"),
      "utf8"
    );
    const readyIndex = source.indexOf("const ready =");
    const menuListenerIndex = source.indexOf(
      "registerMenuClickListener(chrome"
    );
    const commandListenerIndex = source.indexOf("registerCommands(chrome");
    const messageListenerIndex = source.indexOf(
      "chrome.runtime.onMessage.addListener"
    );

    expect(readyIndex).toBeGreaterThan(-1);
    expect(menuListenerIndex).toBeGreaterThan(-1);
    expect(commandListenerIndex).toBeGreaterThan(-1);
    expect(messageListenerIndex).toBeGreaterThan(-1);
    expect(menuListenerIndex).toBeLessThan(readyIndex);
    expect(commandListenerIndex).toBeLessThan(readyIndex);
    expect(messageListenerIndex).toBeLessThan(readyIndex);
  });

  it("retries transient initial manager-query failures until real configuration loads", async () => {
    const configuration = configurationWithWork();
    let attempts = 0;
    const request = vi.fn(async (): Promise<ManagerResponse> => {
      attempts += 1;
      if (attempts < 3) {
        return {
          ok: false,
          error: {
            kind: "transport",
            code: "NO_RESPONSE",
            message: "receiving end does not exist yet"
          }
        };
      }
      return { ok: true, configuration, view };
    });

    render(<ManagerApp transport={{ request }} />);

    expect(
      await screen.findByText("Work", {}, { timeout: 4_000 })
    ).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(1, { kind: "manager-query" });
    expect(request).toHaveBeenNthCalledWith(2, { kind: "manager-query" });
    expect(request).toHaveBeenNthCalledWith(3, { kind: "manager-query" });
  });

  it("does not expose preview mutations while the first real query is pending", async () => {
    const pending = deferred<ManagerResponse>();
    const request = vi.fn(() => pending.promise);

    render(<ManagerApp transport={{ request }} />);

    expect(screen.getByRole("status").textContent).toBe("Loading");
    expect(screen.queryByRole("button", { name: "Add group" })).toBeNull();

    pending.resolve({ ok: true, configuration: configurationWithWork(), view });

    expect(
      await screen.findByRole("button", { name: "Add group" })
    ).toBeTruthy();
  });

  it("shows a reconnect surface instead of editable preview state after initial failure", async () => {
    const request = vi.fn(async (): Promise<ManagerResponse> => ({
      ok: false,
      error: {
        kind: "offline",
        code: "OFFLINE",
        message: "Chrome runtime is offline"
      }
    }));

    render(<ManagerApp transport={{ request }} />);

    expect(
      await screen.findByRole("heading", { name: "Manager unavailable" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add group" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Retry connection" })
    ).toBeTruthy();
  });
});
