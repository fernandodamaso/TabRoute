import { findTab, isRoutableUrl } from "../chrome/types";
import type {
  ChromeAssociation,
  ChromeInventory,
  Configuration,
  UUID
} from "../domain/types";
import { renderGroupTitle } from "../groups/displayTitle";
import {
  findManagedGroupForTab,
  findPersistentTabId,
  resolvePauseTarget
} from "../controller/executeUserCommand";
import type { CommandResult, UserCommand } from "../controller/userCommands";

const MENU_CONTEXTS = ["tab", "page"] as [
  chrome.contextMenus.ContextType,
  chrome.contextMenus.ContextType
];

export const MENU_IDS = {
  createRule: "tabroute:create-rule",
  makePersistent: "tabroute:make-persistent",
  removePersistent: "tabroute:remove-persistent",
  excludeDuplicate: "tabroute:exclude-duplicate",
  moveSubmenu: "tabroute:move-submenu",
  moveOther: "tabroute:move-other",
  pauseScope: "tabroute:pause-scope",
  pinGroup: "tabroute:pin-group",
  collapseGroup: "tabroute:collapse-group",
  expandGroup: "tabroute:expand-group",
  saveSnapshot: "tabroute:save-snapshot"
} as const;

export function moveGroupMenuId(managedGroupId: UUID): string {
  return `tabroute:move-group:${managedGroupId}`;
}

export interface MenuContext {
  configuration: Configuration;
  inventory: ChromeInventory;
  associations: readonly ChromeAssociation[];
  checkpointInFlight: boolean;
  availableUndoId?: UUID;
}

export interface MenuCommandHost {
  executeUserCommand(command: UserCommand): Promise<CommandResult>;
  readMenuContext(): Promise<MenuContext>;
}

type Availability = {
  routable: boolean;
  shared: boolean;
  managedGroupId?: UUID;
  persistentTabId?: UUID;
  pauseTitle: string;
  canSaveSnapshot: boolean;
};

function availabilityForTab(
  context: MenuContext,
  tabId: number | undefined,
  now = Date.now()
): Availability {
  const tab = tabId === undefined ? undefined : findTab(context.inventory, tabId);
  const active =
    tab ??
    context.inventory.tabs.find((candidate) => candidate.active) ??
    context.inventory.tabs[0];
  const routable = !!active?.url && isRoutableUrl(active.url);
  const group =
    active && active.chromeGroupId >= 0
      ? context.inventory.groups.find(
          (candidate) =>
            candidate.id === active.chromeGroupId &&
            candidate.windowId === active.windowId
        )
      : undefined;
  const shared = group?.shared === true;
  const managedGroupId = active
    ? findManagedGroupForTab(active.id, context.inventory, context.associations)
    : undefined;
  const pause = resolvePauseTarget(context.configuration, managedGroupId, now);
  return {
    routable,
    shared,
    managedGroupId,
    persistentTabId: findPersistentTabId(
      context.configuration,
      active?.url,
      managedGroupId
    ),
    pauseTitle: pause.duration.kind === "resume" ? "Resume automation" : "Pause automation",
    canSaveSnapshot: !context.checkpointInFlight
  };
}

function createMenu(
  browser: typeof chrome,
  props: chrome.contextMenus.CreateProperties
): void {
  const { onclick: _onclick, ...safe } = props as chrome.contextMenus.CreateProperties & {
    onclick?: unknown;
  };
  browser.contextMenus.create({
    ...safe,
    contexts: MENU_CONTEXTS
  });
}

export async function refreshMenus(
  browser: typeof chrome,
  host: MenuCommandHost
): Promise<void> {
  const context = await host.readMenuContext();
  const active = context.inventory.tabs.find((tab) => tab.active);
  const availability = availabilityForTab(context, active?.id);
  await browser.contextMenus.removeAll();

  createMenu(browser, {
    id: MENU_IDS.createRule,
    title: "Create rule from this tab",
    enabled: availability.routable
  });
  createMenu(browser, {
    id: MENU_IDS.makePersistent,
    title: "Make persistent in this group",
    enabled:
      availability.routable &&
      !availability.shared &&
      availability.managedGroupId !== undefined
  });
  createMenu(browser, {
    id: MENU_IDS.removePersistent,
    title: "Remove persistent tab",
    enabled: availability.persistentTabId !== undefined
  });
  createMenu(browser, {
    id: MENU_IDS.excludeDuplicate,
    title: "Exclude from duplicates",
    enabled: availability.routable
  });
  createMenu(browser, {
    id: MENU_IDS.moveSubmenu,
    title: "Move to group",
    enabled: availability.routable
  });
  for (const group of context.configuration.groups) {
    if (group.isFallback || !group.enabled) continue;
    createMenu(browser, {
      id: moveGroupMenuId(group.id),
      parentId: MENU_IDS.moveSubmenu,
      title: renderGroupTitle(group),
      enabled: availability.routable
    });
  }
  createMenu(browser, {
    id: MENU_IDS.moveOther,
    title: "Move to Other",
    enabled: availability.routable
  });
  createMenu(browser, {
    id: MENU_IDS.pauseScope,
    title: availability.pauseTitle,
    enabled: true
  });
  createMenu(browser, {
    id: MENU_IDS.pinGroup,
    title: "Pin Group",
    enabled: !availability.shared && availability.managedGroupId !== undefined
  });
  createMenu(browser, {
    id: MENU_IDS.collapseGroup,
    title: "Collapse group",
    enabled: !availability.shared && availability.managedGroupId !== undefined
  });
  createMenu(browser, {
    id: MENU_IDS.expandGroup,
    title: "Expand group",
    enabled: !availability.shared && availability.managedGroupId !== undefined
  });
  createMenu(browser, {
    id: MENU_IDS.saveSnapshot,
    title: "Save snapshot",
    enabled: availability.canSaveSnapshot
  });
}

let menusRegistered = false;

export async function registerMenus(
  browser: typeof chrome,
  host: MenuCommandHost
): Promise<void> {
  await refreshMenus(browser, host);
  if (menusRegistered) return;
  menusRegistered = true;
  browser.contextMenus.onClicked.addListener((info, tab) => {
    return handleMenuClick(browser, host, info, tab) as unknown as void;
  });
}

/** @internal test helper */
export function resetMenuRegistrationForTests(): void {
  menusRegistered = false;
}

async function handleMenuClick(
  _browser: typeof chrome,
  host: MenuCommandHost,
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined
): Promise<void> {
  if (tab?.incognito) return;
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const context = await host.readMenuContext();
  const availability = availabilityForTab(context, tabId);
  const menuItemId = String(info.menuItemId);
  const command = commandFromMenuId(
    menuItemId,
    tabId,
    context,
    availability
  );
  if (!command) return;
  if (!commandIsCurrentlyAvailable(command, availability, menuItemId)) return;
  await host.executeUserCommand(command);
}

function commandFromMenuId(
  menuItemId: string,
  tabId: number,
  context: MenuContext,
  availability: Availability
): UserCommand | undefined {
  if (menuItemId === MENU_IDS.createRule) {
    return { kind: "createRuleFromTab", tabId };
  }
  if (menuItemId === MENU_IDS.makePersistent) {
    if (!availability.managedGroupId) return undefined;
    return {
      kind: "makePersistent",
      tabId,
      managedGroupId: availability.managedGroupId
    };
  }
  if (menuItemId === MENU_IDS.removePersistent) {
    if (!availability.persistentTabId) return undefined;
    return {
      kind: "removePersistent",
      persistentTabId: availability.persistentTabId
    };
  }
  if (menuItemId === MENU_IDS.excludeDuplicate) {
    return { kind: "excludeFromDuplicates", tabId };
  }
  if (menuItemId === MENU_IDS.moveOther) {
    return { kind: "moveToOther", tabId };
  }
  if (menuItemId.startsWith("tabroute:move-group:")) {
    const managedGroupId = menuItemId.slice("tabroute:move-group:".length) as UUID;
    return { kind: "moveToGroup", tabId, managedGroupId };
  }
  if (menuItemId === MENU_IDS.pauseScope) {
    const pause = resolvePauseTarget(
      context.configuration,
      availability.managedGroupId,
      Date.now()
    );
    return { kind: "setPause", target: pause.target, duration: pause.duration };
  }
  if (menuItemId === MENU_IDS.pinGroup) {
    if (!availability.managedGroupId) return undefined;
    return { kind: "pinGroup", managedGroupId: availability.managedGroupId };
  }
  if (menuItemId === MENU_IDS.collapseGroup) {
    if (!availability.managedGroupId) return undefined;
    return {
      kind: "setGroupCollapsed",
      managedGroupId: availability.managedGroupId,
      collapsed: true
    };
  }
  if (menuItemId === MENU_IDS.expandGroup) {
    if (!availability.managedGroupId) return undefined;
    return {
      kind: "setGroupCollapsed",
      managedGroupId: availability.managedGroupId,
      collapsed: false
    };
  }
  if (menuItemId === MENU_IDS.saveSnapshot) {
    return {
      kind: "saveSnapshot",
      scope: { kind: "browser" },
      name: `Snapshot ${new Date().toISOString()}`
    };
  }
  return undefined;
}

function commandIsCurrentlyAvailable(
  command: UserCommand,
  availability: Availability,
  _menuItemId: string
): boolean {
  if (command.kind === "saveSnapshot") return availability.canSaveSnapshot;
  if (
    command.kind === "createRuleFromTab" ||
    command.kind === "excludeFromDuplicates" ||
    command.kind === "moveToOther" ||
    command.kind === "moveToGroup"
  ) {
    return availability.routable;
  }
  if (command.kind === "makePersistent") {
    return (
      availability.routable &&
      !availability.shared &&
      availability.managedGroupId !== undefined
    );
  }
  if (command.kind === "pinGroup" || command.kind === "setGroupCollapsed") {
    return !availability.shared && availability.managedGroupId !== undefined;
  }
  return true;
}
