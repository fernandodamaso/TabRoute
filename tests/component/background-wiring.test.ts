import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import type { Configuration, UUID } from "../../src/domain/types";
import {
  registerCommands,
  resetCommandRegistrationForTests
} from "../../src/background/registerCommands";
import {
  registerMenus,
  resetMenuRegistrationForTests
} from "../../src/background/registerMenus";
import type { UserCommand } from "../../src/controller/userCommands";

type MenuCreateProps = {
  id?: string;
  title?: string;
  contexts?: string[];
  parentId?: string;
  enabled?: boolean;
  onclick?: unknown;
};

function createEventTarget<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener(listener: (...args: T) => void) {
      listeners.add(listener);
    },
    removeListener(listener: (...args: T) => void) {
      listeners.delete(listener);
    },
    listenerCount() {
      return listeners.size;
    },
    async emit(...args: T) {
      const pending: Promise<unknown>[] = [];
      for (const listener of [...listeners]) {
        pending.push(Promise.resolve(listener(...args)));
      }
      await Promise.all(pending);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
}

function createFakeBrowser(input?: {
  configuration?: Configuration;
  inventoryTabs?: Array<{
    id: number;
    windowId: number;
    url?: string;
    incognito?: boolean;
    groupId?: number;
    active?: boolean;
  }>;
  inventoryGroups?: Array<{
    id: number;
    windowId: number;
    shared?: boolean;
    title?: string;
    collapsed?: boolean;
  }>;
  checkpointInFlight?: boolean;
}) {
  const configuration =
    input?.configuration ??
    createDefaultConfiguration(() => "11111111-1111-4111-8111-111111111111");
  const creates: MenuCreateProps[] = [];
  const removes: string[] = [];
  let removeAllCount = 0;
  const mutationSpies = {
    tabsRemove: vi.fn(),
    tabsCreate: vi.fn(),
    tabsGroup: vi.fn(),
    tabsUngroup: vi.fn(),
    tabsMove: vi.fn(),
    tabGroupsUpdate: vi.fn(),
    sessionsRestore: vi.fn()
  };
  const commands = createEventTarget<[string, chrome.tabs.Tab?]>();
  const clicked =
    createEventTarget<[chrome.contextMenus.OnClickData, chrome.tabs.Tab?]>();
  const openOptionsPage = vi.fn(async () => undefined);
  const executed: UserCommand[] = [];

  const workId = "22222222-2222-4222-8222-222222222222" as UUID;
  const designId = "33333333-3333-4333-8333-333333333333" as UUID;
  let config = configuration;
  if (!input?.configuration) {
    config = createManagedGroup(
      config,
      { name: "Work", color: "blue" },
      () => workId
    );
  }

  const tabs = input?.inventoryTabs ?? [
    {
      id: 10,
      windowId: 1,
      url: "https://example.com/",
      incognito: false,
      groupId: -1,
      active: true
    }
  ];
  const groups = input?.inventoryGroups ?? [
    {
      id: 5,
      windowId: 1,
      shared: false,
      title: "Work",
      collapsed: false
    }
  ];

  const browser = {
    contextMenus: {
      onClicked: clicked,
      create: vi.fn((props: MenuCreateProps, callback?: () => void) => {
        creates.push(props);
        callback?.();
        return props.id ?? "generated";
      }),
      remove: vi.fn(async (id: string) => {
        removes.push(id);
      }),
      removeAll: vi.fn(async () => {
        removeAllCount += 1;
        creates.length = 0;
      }),
      update: vi.fn(async () => undefined)
    },
    commands: {
      onCommand: commands
    },
    runtime: {
      openOptionsPage,
      onInstalled: createEventTarget<[chrome.runtime.InstalledDetails]>()
    },
    tabs: {
      query: vi.fn(async (query: { active?: boolean; windowId?: number }) =>
        tabs.filter(
          (tab) =>
            (query.active === undefined || tab.active === query.active) &&
            (query.windowId === undefined || tab.windowId === query.windowId)
        )
      ),
      remove: mutationSpies.tabsRemove,
      create: mutationSpies.tabsCreate,
      group: mutationSpies.tabsGroup,
      ungroup: mutationSpies.tabsUngroup,
      move: mutationSpies.tabsMove
    },
    tabGroups: {
      update: mutationSpies.tabGroupsUpdate
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: vi.fn(async () => ({
        id: 1,
        incognito: false,
        type: "normal"
      }))
    },
    sessions: {
      restore: mutationSpies.sessionsRestore
    },
    notifications: undefined
  };

  const controller = {
    getConfiguration: () => config,
    async executeUserCommand(command: UserCommand) {
      executed.push(command);
      return { ok: true as const };
    },
    async readMenuContext() {
      return {
        configuration: config,
        inventory: {
          capturedAt: 1,
          windows: [
            { id: 1, focused: true, incognito: false, type: "normal" as const }
          ],
          tabs: tabs.map((tab) => ({
            id: tab.id,
            windowId: tab.windowId,
            index: 0,
            chromeGroupId: tab.groupId ?? -1,
            url: tab.url,
            title: "Example",
            pinned: false,
            active: tab.active ?? false,
            incognito: false as const,
            lastAccessed: 1
          })),
          groups: groups.map((group) => ({
            id: group.id,
            windowId: group.windowId,
            title: group.title ?? "",
            color: "blue" as const,
            collapsed: group.collapsed ?? false,
            shared: group.shared ?? false
          }))
        },
        associations: [
          {
            managedGroupId: workId,
            chromeGroupId: 5,
            chromeWindowId: 1,
            observedTitle: "Work",
            observedMemberUrls: ["https://example.com/"],
            observedAt: 1
          }
        ],
        checkpointInFlight: input?.checkpointInFlight ?? false,
        availableUndoId: undefined as UUID | undefined
      };
    },
    setConfiguration(next: Configuration) {
      config = next;
    },
    workId,
    designId
  };

  return {
    browser: browser as unknown as typeof chrome,
    controller,
    creates: () => creates,
    removeAllCount: () => removeAllCount,
    executed: () => executed,
    mutationSpies,
    openOptionsPage,
    clicked,
    commands,
    workId,
    designId
  };
}

describe("background menus and commands wiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetMenuRegistrationForTests();
    resetCommandRegistrationForTests();
  });

  it("registers stable handlers once and never registers notifications", async () => {
    const fake = createFakeBrowser();
    await registerMenus(fake.browser, fake.controller);
    registerCommands(fake.browser, fake.controller);
    await registerMenus(fake.browser, fake.controller);
    registerCommands(fake.browser, fake.controller);
    expect(
      (
        fake.browser.contextMenus.onClicked as unknown as {
          listenerCount(): number;
        }
      ).listenerCount()
    ).toBe(1);
    expect(
      (
        fake.browser.commands.onCommand as unknown as {
          listenerCount(): number;
        }
      ).listenerCount()
    ).toBe(1);
    expect(fake.browser.notifications).toBeUndefined();
    const menusSource = readFileSync(
      join(process.cwd(), "src/background/registerMenus.ts"),
      "utf8"
    );
    const commandsSource = readFileSync(
      join(process.cwd(), "src/background/registerCommands.ts"),
      "utf8"
    );
    expect(menusSource).not.toMatch(/chrome\.notifications/);
    expect(commandsSource).not.toMatch(/chrome\.notifications/);
  });

  it("creates Task 18 menu IDs without onclick and only enabled non-fallback move children", async () => {
    const fake = createFakeBrowser();
    let config = fake.controller.getConfiguration();
    config = createManagedGroup(
      config,
      { name: "Design", color: "pink" },
      () => fake.designId
    );
    config = {
      ...config,
      groups: config.groups.map((group) =>
        group.id === fake.designId ? { ...group, enabled: false } : group
      )
    };
    fake.controller.setConfiguration(config);
    await registerMenus(fake.browser, fake.controller);
    const ids = fake.creates().map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "tabroute:create-rule",
        "tabroute:make-persistent",
        "tabroute:remove-persistent",
        "tabroute:exclude-duplicate",
        "tabroute:move-submenu",
        `tabroute:move-group:${fake.workId}`,
        "tabroute:move-other",
        "tabroute:pause-scope",
        "tabroute:pin-group",
        "tabroute:collapse-group",
        "tabroute:expand-group",
        "tabroute:save-snapshot"
      ])
    );
    expect(ids).not.toContain(`tabroute:move-group:${config.fallbackGroupId}`);
    expect(ids).not.toContain(`tabroute:move-group:${fake.designId}`);
    for (const created of fake.creates()) {
      expect(created.onclick).toBeUndefined();
      expect(created.contexts).toEqual(["tab", "page"]);
    }
  });

  it("dispatches move-other through executeUserCommand and never mutates Chrome directly", async () => {
    const fake = createFakeBrowser();
    await registerMenus(fake.browser, fake.controller);
    await fake.clicked.emit(
      { menuItemId: "tabroute:move-other" } as chrome.contextMenus.OnClickData,
      {
        id: 10,
        windowId: 1,
        url: "https://example.com/",
        incognito: false
      } as chrome.tabs.Tab
    );
    expect(fake.executed()).toEqual([{ kind: "moveToOther", tabId: 10 }]);
    expect(fake.mutationSpies.tabsRemove).not.toHaveBeenCalled();
    expect(fake.mutationSpies.tabsCreate).not.toHaveBeenCalled();
    expect(fake.mutationSpies.tabsGroup).not.toHaveBeenCalled();
    expect(fake.mutationSpies.tabsUngroup).not.toHaveBeenCalled();
    expect(fake.mutationSpies.tabsMove).not.toHaveBeenCalled();
    expect(fake.mutationSpies.tabGroupsUpdate).not.toHaveBeenCalled();
  });

  it("disables shared-group pin/collapse/make-persistent but still dispatches move-out", async () => {
    const fake = createFakeBrowser({
      inventoryTabs: [
        {
          id: 10,
          windowId: 1,
          url: "https://example.com/",
          groupId: 5,
          active: true
        }
      ],
      inventoryGroups: [
        {
          id: 5,
          windowId: 1,
          shared: true,
          title: "Shared"
        }
      ]
    });
    await registerMenus(fake.browser, fake.controller);
    const byId = Object.fromEntries(
      fake.creates().map((item) => [item.id!, item])
    );
    expect(byId["tabroute:pin-group"]?.enabled).toBe(false);
    expect(byId["tabroute:collapse-group"]?.enabled).toBe(false);
    expect(byId["tabroute:expand-group"]?.enabled).toBe(false);
    expect(byId["tabroute:make-persistent"]?.enabled).toBe(false);
    expect(byId["tabroute:move-other"]?.enabled).toBe(true);
    await fake.clicked.emit(
      { menuItemId: "tabroute:move-other" } as chrome.contextMenus.OnClickData,
      {
        id: 10,
        windowId: 1,
        url: "https://example.com/",
        incognito: false
      } as chrome.tabs.Tab
    );
    expect(fake.executed()).toEqual([{ kind: "moveToOther", tabId: 10 }]);
  });

  it("disables create/make/move for unsupported URLs", async () => {
    const fake = createFakeBrowser({
      inventoryTabs: [
        {
          id: 10,
          windowId: 1,
          url: "chrome://extensions",
          active: true
        }
      ]
    });
    await registerMenus(fake.browser, fake.controller);
    const byId = Object.fromEntries(
      fake.creates().map((item) => [item.id!, item])
    );
    expect(byId["tabroute:create-rule"]?.enabled).toBe(false);
    expect(byId["tabroute:make-persistent"]?.enabled).toBe(false);
    expect(byId["tabroute:move-other"]?.enabled).toBe(false);
    expect(byId[`tabroute:move-group:${fake.workId}`]?.enabled).toBe(false);
  });

  it("does not block user commands when automation is paused", async () => {
    const configuration = createDefaultConfiguration(
      () => "11111111-1111-4111-8111-111111111111"
    );
    const withWork = createManagedGroup(
      { ...configuration, globalPausedUntil: "restart" },
      { name: "Work", color: "blue" },
      () => "22222222-2222-4222-8222-222222222222"
    );
    const fake = createFakeBrowser({ configuration: withWork });
    await registerMenus(fake.browser, fake.controller);
    const byId = Object.fromEntries(
      fake.creates().map((item) => [item.id!, item])
    );
    expect(byId["tabroute:move-other"]?.enabled).toBe(true);
    await fake.clicked.emit(
      { menuItemId: "tabroute:move-other" } as chrome.contextMenus.OnClickData,
      {
        id: 10,
        windowId: 1,
        url: "https://example.com/",
        incognito: false
      } as chrome.tabs.Tab
    );
    expect(fake.executed()).toEqual([{ kind: "moveToOther", tabId: 10 }]);
  });

  it("disables save-snapshot while a checkpoint is in flight", async () => {
    const fake = createFakeBrowser({ checkpointInFlight: true });
    await registerMenus(fake.browser, fake.controller);
    const byId = Object.fromEntries(
      fake.creates().map((item) => [item.id!, item])
    );
    expect(byId["tabroute:save-snapshot"]?.enabled).toBe(false);
    await fake.clicked.emit(
      {
        menuItemId: "tabroute:save-snapshot"
      } as chrome.contextMenus.OnClickData,
      {
        id: 10,
        windowId: 1,
        url: "https://example.com/",
        incognito: false
      } as chrome.tabs.Tab
    );
    expect(fake.executed()).toEqual([]);
  });

  it("no-ops an incognito click", async () => {
    const fake = createFakeBrowser();
    await registerMenus(fake.browser, fake.controller);
    await fake.clicked.emit(
      { menuItemId: "tabroute:move-other" } as chrome.contextMenus.OnClickData,
      {
        id: 10,
        windowId: 1,
        url: "https://example.com/",
        incognito: true
      } as chrome.tabs.Tab
    );
    expect(fake.executed()).toEqual([]);
  });

  it("create-rule dispatches createRuleFromTab and does not saveRule", async () => {
    const fake = createFakeBrowser();
    await registerMenus(fake.browser, fake.controller);
    await fake.clicked.emit(
      { menuItemId: "tabroute:create-rule" } as chrome.contextMenus.OnClickData,
      {
        id: 10,
        windowId: 1,
        url: "https://example.com/",
        incognito: false
      } as chrome.tabs.Tab
    );
    expect(fake.executed()).toEqual([{ kind: "createRuleFromTab", tabId: 10 }]);
    expect(fake.executed().some((command) => command.kind === "saveRule")).toBe(
      false
    );
  });

  it("routes approved command names and ignores unknown names", async () => {
    const fake = createFakeBrowser();
    registerCommands(fake.browser, fake.controller);
    await fake.commands.emit("toggle-automation");
    await fake.commands.emit("not-a-real-command");
    expect(fake.executed()).toEqual([{ kind: "toggleAutomation" }]);
  });

  it("blocks make-persistent and pin-group shortcuts for shared-group tabs", async () => {
    const fake = createFakeBrowser({
      inventoryTabs: [
        {
          id: 10,
          windowId: 1,
          url: "https://example.com/",
          groupId: 5,
          active: true
        }
      ],
      inventoryGroups: [
        {
          id: 5,
          windowId: 1,
          shared: true,
          title: "Shared"
        }
      ]
    });
    registerCommands(fake.browser, fake.controller);
    await fake.commands.emit("make-persistent");
    await fake.commands.emit("pin-group");
    await fake.commands.emit("move-to-other");
    expect(fake.executed()).toEqual([{ kind: "moveToOther", tabId: 10 }]);
  });

  it("uses the last-focused normal window for shortcuts", async () => {
    const fake = createFakeBrowser({
      inventoryTabs: [
        {
          id: 99,
          windowId: 1,
          url: "https://example.com/",
          active: true
        }
      ]
    });
    registerCommands(fake.browser, fake.controller);
    await fake.commands.emit("move-to-other");
    expect(fake.browser.windows.getLastFocused).toHaveBeenCalledWith({
      windowTypes: ["normal"]
    });
    expect(fake.executed()).toEqual([{ kind: "moveToOther", tabId: 99 }]);
  });
});
