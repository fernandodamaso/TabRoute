import { describe, expect, it } from "vitest";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import type { Configuration, PersistentTab, UUID } from "../../src/domain/types";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { createMemoryLocalRepository } from "../../src/state/localRepository";
import { createFakeChromePort } from "../fakes/fakeChromePort";
import { createTestController } from "../helpers/controllerPersistence";

const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
const docsId = "00000000-0000-4000-8000-000000000002" as UUID;
const persistentId = "00000000-0000-4000-8000-000000000010" as UUID;
const persistentUrl = "https://docs.example.com/guide";

function configuration(): Configuration {
  const base = createManagedGroup(
    createDefaultConfiguration(
      () => fallbackId,
      () => 1
    ),
    { name: "Docs", color: "blue" },
    () => docsId,
    () => 1
  );
  const persistent: PersistentTab = {
    schemaVersion: 1,
    id: persistentId,
    managedGroupId: docsId,
    canonicalUrl: persistentUrl,
    acceptedPatterns: [persistentUrl],
    order: 0,
    createdAt: 1,
    updatedAt: 1
  };
  return {
    ...base,
    groups: base.groups.map((group) =>
      group.id === docsId ? { ...group, isPersistent: true } : group
    ),
    persistentTabs: [persistent],
    restorePersistentGroups: true
  };
}

describe("PR 10 round 4 persistent close settlement", () => {
  it("does not recreate a persistent tab before a disappeared native group can settle as intentionally closed", async () => {
    const config = configuration();
    const session = createMemorySessionRepository();
    const runtime = await session.loadSession();
    await session.saveSession({
      ...runtime,
      nextObservationOrdinal: 2,
      lastFocusedNormalWindowId: 1,
      tabObservations: [
        {
          tabId: 42,
          firstObservedAt: 1,
          firstObservedOrdinal: 1,
          lastObservedUrl: persistentUrl
        }
      ],
      associations: [
        {
          managedGroupId: docsId,
          chromeGroupId: 11,
          chromeWindowId: 1,
          observedTitle: "Docs",
          observedMemberUrls: [persistentUrl],
          observedAt: 1
        }
      ]
    });
    const chrome = createFakeChromePort({
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 2
    });
    const controller = createTestController({
      configuration: config,
      chrome,
      session,
      local: createMemoryLocalRepository(),
      now: () => 2
    });

    await controller.handleChromeEvent({
      kind: "tabRemoved",
      tabId: 42,
      windowId: 1,
      isWindowClosing: false
    });

    expect(chrome.callsFor("createTab")).toHaveLength(0);
  });
});
