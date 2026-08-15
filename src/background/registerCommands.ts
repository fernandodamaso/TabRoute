import { findTab, isRoutableUrl } from "../chrome/types";
import {
  findManagedGroupForTab,
  findPersistentTabId
} from "../controller/executeUserCommand";
import type { CommandResult, UserCommand } from "../controller/userCommands";
import type { MenuCommandHost, MenuContext } from "./registerMenus";

export const MANIFEST_COMMAND_NAMES = [
  "open-manager",
  "create-rule-from-tab",
  "toggle-automation",
  "save-snapshot",
  "make-persistent",
  "remove-persistent",
  "pin-group",
  "move-to-other",
  "undo"
] as const;

export type ManifestCommandName = (typeof MANIFEST_COMMAND_NAMES)[number];

export interface CommandHost extends MenuCommandHost {
  executeUserCommand(command: UserCommand): Promise<CommandResult>;
  readMenuContext(): Promise<MenuContext>;
}

let commandsRegistered = false;

export function registerCommands(
  browser: typeof chrome,
  host: CommandHost
): void {
  if (commandsRegistered) return;
  commandsRegistered = true;
  browser.commands.onCommand.addListener((command, tab) => {
    return handleCommand(browser, host, command, tab).catch((error: unknown) => {
      console.error("TabRoute manifest command failed", error);
    }) as unknown as void;
  });
}

/** @internal test helper */
export function resetCommandRegistrationForTests(): void {
  commandsRegistered = false;
}

async function handleCommand(
  browser: typeof chrome,
  host: CommandHost,
  commandName: string,
  tabFromEvent: chrome.tabs.Tab | undefined
): Promise<void> {
  if (!isManifestCommandName(commandName)) return;
  const contextTab = await resolveActiveNormalTab(browser, tabFromEvent);
  if (contextTab?.incognito) return;
  const menuContext = await host.readMenuContext();
  const command = await commandFromName(
    commandName,
    contextTab,
    menuContext,
    host
  );
  if (!command) return;
  if (command.kind === "saveSnapshot" && menuContext.checkpointInFlight) {
    return;
  }
  if (
    (command.kind === "createRuleFromTab" ||
      command.kind === "makePersistent" ||
      command.kind === "moveToOther") &&
    contextTab &&
    (!contextTab.url || !isRoutableUrl(contextTab.url))
  ) {
    return;
  }
  if (
    (command.kind === "makePersistent" || command.kind === "pinGroup") &&
    contextTab?.id !== undefined
  ) {
    const inventoryTab = findTab(menuContext.inventory, contextTab.id);
    const group =
      inventoryTab && inventoryTab.chromeGroupId >= 0
        ? menuContext.inventory.groups.find(
            (candidate) =>
              candidate.id === inventoryTab.chromeGroupId &&
              candidate.windowId === inventoryTab.windowId
          )
        : undefined;
    if (group?.shared) return;
  }
  await host.executeUserCommand(command);
}

function isManifestCommandName(value: string): value is ManifestCommandName {
  return (MANIFEST_COMMAND_NAMES as readonly string[]).includes(value);
}

async function resolveActiveNormalTab(
  browser: typeof chrome,
  tabFromEvent: chrome.tabs.Tab | undefined
): Promise<chrome.tabs.Tab | undefined> {
  if (tabFromEvent?.id !== undefined && tabFromEvent.incognito !== true) {
    return tabFromEvent;
  }
  const focused = await browser.windows.getLastFocused({
    windowTypes: ["normal"]
  });
  if (
    focused.id === undefined ||
    focused.id === browser.windows.WINDOW_ID_NONE ||
    focused.incognito
  ) {
    return undefined;
  }
  const tabs = await browser.tabs.query({
    active: true,
    windowId: focused.id
  });
  return tabs[0];
}

async function commandFromName(
  name: ManifestCommandName,
  tab: chrome.tabs.Tab | undefined,
  context: MenuContext,
  _host: CommandHost
): Promise<UserCommand | undefined> {
  switch (name) {
    case "open-manager":
      return { kind: "openManager" };
    case "toggle-automation":
      return { kind: "toggleAutomation" };
    case "save-snapshot":
      return {
        kind: "saveSnapshot",
        scope: { kind: "browser" },
        name: `Snapshot ${new Date().toISOString()}`
      };
    case "undo": {
      if (!context.availableUndoId) return undefined;
      return { kind: "undo", undoId: context.availableUndoId };
    }
    case "create-rule-from-tab":
    case "make-persistent":
    case "remove-persistent":
    case "pin-group":
    case "move-to-other": {
      if (tab?.id === undefined) return undefined;
      const inventoryTab = findTab(context.inventory, tab.id);
      const managedGroupId = findManagedGroupForTab(
        tab.id,
        context.inventory,
        context.associations
      );
      if (name === "create-rule-from-tab") {
        return { kind: "createRuleFromTab", tabId: tab.id };
      }
      if (name === "move-to-other") {
        return { kind: "moveToOther", tabId: tab.id };
      }
      if (name === "make-persistent") {
        if (!managedGroupId) return undefined;
        return {
          kind: "makePersistent",
          tabId: tab.id,
          managedGroupId
        };
      }
      if (name === "remove-persistent") {
        const persistentTabId = findPersistentTabId(
          context.configuration,
          inventoryTab?.url ?? tab.url,
          managedGroupId
        );
        if (!persistentTabId) return undefined;
        return { kind: "removePersistent", persistentTabId };
      }
      if (name === "pin-group") {
        if (!managedGroupId) return undefined;
        return { kind: "pinGroup", managedGroupId };
      }
      return undefined;
    }
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}
