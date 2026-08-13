import { describe, expect, it } from "vitest";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import { createTestController } from "../helpers/controllerPersistence";
import { persistenceConfiguration } from "./startup-restore.helpers";
import type { UUID } from "../../src/domain/types";

describe("startup restore component", () => {
  it("recreates a closed persistent tab in the background", async () => {
    const config = persistenceConfiguration();
    const chrome = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 7,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://docs.example.com/guide",
          title: "Guide",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    });
    const sessionRepo = (await import("../../src/state/sessionRepository")).createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    await sessionRepo.saveSession({
      ...session,
      associations: [
        {
          managedGroupId: "00000000-0000-4000-8000-000000000002" as UUID,
          chromeGroupId: 11,
          chromeWindowId: 1,
          observedTitle: "Docs",
          observedMemberUrls: ["https://docs.example.com/guide"],
          observedAt: 1
        }
      ],
      tabObservations: [
        {
          tabId: 7,
          firstObservedAt: 1,
          firstObservedOrdinal: 0,
          lastObservedUrl: "https://docs.example.com/guide"
        }
      ]
    });
    const controller = createTestController({
      configuration: config,
      chrome,
      session: sessionRepo
    });
    const storage = chrome.getStorage();
    storage.inventory = {
      ...storage.inventory,
      tabs: storage.inventory.tabs.filter((tab) => tab.id !== 7)
    };
    await controller.handleChromeEvent({
      kind: "tabRemoved",
      tabId: 7,
      windowId: 1,
      isWindowClosing: false
    });
    const inventory = await chrome.readInventory();
    const recreated = inventory.tabs.find(
      (tab) => tab.url === "https://docs.example.com/guide"
    );
    expect(recreated).toBeTruthy();
    expect(chrome.callsFor("createTab").length).toBeGreaterThan(0);
  });

  it("does not recreate persistent tabs during window-close batching", async () => {
    const config = persistenceConfiguration();
    const chrome = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 7,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://docs.example.com/guide",
          title: "Guide",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    });
    const controller = createTestController({ configuration: config, chrome });
    await controller.handleChromeEvent({
      kind: "tabRemoved",
      tabId: 7,
      windowId: 1,
      isWindowClosing: true
    });
    expect(chrome.callsFor("createTab").length).toBe(0);
  });

  it("recreates canonical tab after navigate-away through controller reconcile", async () => {
    const config = persistenceConfiguration();
    const chrome = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 7,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://github.com/",
          title: "GitHub",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    });
    const sessionRepo = (await import("../../src/state/sessionRepository")).createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    await sessionRepo.saveSession({
      ...session,
      associations: [
        {
          managedGroupId: "00000000-0000-4000-8000-000000000002" as UUID,
          chromeGroupId: 11,
          chromeWindowId: 1,
          observedTitle: "Docs",
          observedMemberUrls: ["https://docs.example.com/guide"],
          observedAt: 1
        }
      ]
    });
    const controller = createTestController({
      configuration: config,
      chrome,
      session: sessionRepo
    });
    await controller.handleTabUpdated({
      id: 7,
      windowId: 1,
      index: 0,
      chromeGroupId: 11,
      url: "https://github.com/",
      title: "GitHub",
      pinned: false,
      active: true,
      incognito: false,
      lastAccessed: 2
    });
    const inventory = await chrome.readInventory();
    const recreated = inventory.tabs.find(
      (tab) => tab.url === "https://docs.example.com/guide"
    );
    expect(recreated).toBeTruthy();
    expect(chrome.callsFor("createTab").length).toBeGreaterThan(0);
  });

  it("still recreates closed persistent tabs when restorePersistentGroups is false", async () => {
    const config = persistenceConfiguration({ restorePersistentGroups: false });
    const chrome = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 7,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://docs.example.com/guide",
          title: "Guide",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    });
    const sessionRepo = (await import("../../src/state/sessionRepository")).createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    await sessionRepo.saveSession({
      ...session,
      associations: [
        {
          managedGroupId: "00000000-0000-4000-8000-000000000002" as UUID,
          chromeGroupId: 11,
          chromeWindowId: 1,
          observedTitle: "Docs",
          observedMemberUrls: ["https://docs.example.com/guide"],
          observedAt: 1
        }
      ],
      tabObservations: [
        {
          tabId: 7,
          firstObservedAt: 1,
          firstObservedOrdinal: 0,
          lastObservedUrl: "https://docs.example.com/guide"
        }
      ]
    });
    const controller = createTestController({
      configuration: config,
      chrome,
      session: sessionRepo
    });
    const storage = chrome.getStorage();
    storage.inventory = {
      ...storage.inventory,
      tabs: storage.inventory.tabs.filter((tab) => tab.id !== 7)
    };
    await controller.handleChromeEvent({
      kind: "tabRemoved",
      tabId: 7,
      windowId: 1,
      isWindowClosing: false
    });
    expect(chrome.callsFor("createTab").length).toBeGreaterThan(0);
  });

  it("still repairs persistent tabs while automation is paused", async () => {
    const config = persistenceConfiguration({
      globalPausedUntil: Date.now() + 60_000
    });
    const chrome = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 7,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://github.com/",
          title: "GitHub",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    });
    const sessionRepo = (await import("../../src/state/sessionRepository")).createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    await sessionRepo.saveSession({
      ...session,
      associations: [
        {
          managedGroupId: "00000000-0000-4000-8000-000000000002" as UUID,
          chromeGroupId: 11,
          chromeWindowId: 1,
          observedTitle: "Docs",
          observedMemberUrls: ["https://docs.example.com/guide"],
          observedAt: 1
        }
      ]
    });
    const controller = createTestController({
      configuration: config,
      chrome,
      session: sessionRepo
    });
    await controller.handleTabUpdated({
      id: 7,
      windowId: 1,
      index: 0,
      chromeGroupId: 11,
      url: "https://github.com/",
      title: "GitHub",
      pinned: false,
      active: true,
      incognito: false,
      lastAccessed: 2
    });
    expect(chrome.callsFor("createTab").length).toBeGreaterThan(0);
  });

  it("does not run full startup restore on ordinary tabCreated", async () => {
    const config = persistenceConfiguration();
    const chrome = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [
        {
          id: 11,
          windowId: 1,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    });
    const sessionRepo = (await import("../../src/state/sessionRepository")).createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    await sessionRepo.saveSession({
      ...session,
      associations: [
        {
          managedGroupId: "00000000-0000-4000-8000-000000000002" as UUID,
          chromeGroupId: 11,
          chromeWindowId: 1,
          observedTitle: "Docs",
          observedMemberUrls: [],
          observedAt: 1
        }
      ]
    });
    const controller = createTestController({
      configuration: config,
      chrome,
      session: sessionRepo
    });
    await controller.handleChromeEvent({ kind: "tabCreated", tabId: 50 });
    const canonicalCreates = chrome.callsFor("createTab").filter((call) => {
      const input = call[0] as { url?: string };
      return input.url === "https://docs.example.com/guide";
    });
    expect(canonicalCreates).toHaveLength(0);
  });
});
