import { describe, expect, it } from "vitest";
import { createUuid } from "../../src/domain/ids";
import { captureSnapshot } from "../../src/snapshots/captureSnapshot";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import { observeInventory } from "../../src/duplicates/observations";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import { reconstructAssociations } from "../../src/chrome/reconstructAssociations";
import type { UUID } from "../../src/domain/types";

describe("snapshot capture", () => {
  it("captures durable identity without Chrome runtime IDs", async () => {
    const configuration = createDefaultConfiguration(() => createUuid());
    const raw = {
      windows: [
        {
          id: 1,
          focused: true,
          incognito: false as const,
          type: "normal" as const
        }
      ],
      tabs: [
        {
          id: 7,
          windowId: 1,
          index: 0,
          chromeGroupId: -1,
          url: "https://example.com/",
          title: "Example",
          pinned: false,
          active: true,
          incognito: false as const,
          lastAccessed: 1
        }
      ],
      groups: [],
      capturedAt: 1
    };
    const session = await createMemorySessionRepository().loadSession();
    const { inventory } = observeInventory(raw, session);
    const associations = reconstructAssociations(raw, configuration);
    const snapshot = captureSnapshot(
      { kind: "browser" },
      inventory,
      { configuration, ownership: {}, associations },
      { id: createUuid(), name: "Before action", kind: "checkpoint", now: 1 }
    );
    expect(snapshot.groups[0]?.managedGroupId).toBe(
      configuration.fallbackGroupId
    );
    expect(snapshot.groups[0]?.tabs).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toMatch(/chrome(Tab|Group|Window)Id/);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /\b(tabId|groupId|windowId)\b/
    );
  });

  it("captures only the scoped group's tabs in a multi-group browser", async () => {
    const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
    const workId = "00000000-0000-4000-8000-000000000002" as UUID;
    const configuration = createManagedGroup(
      createDefaultConfiguration(() => fallbackId),
      { name: "Work", color: "blue" },
      () => workId
    );
    const raw = {
      windows: [
        {
          id: 1,
          focused: true,
          incognito: false as const,
          type: "normal" as const
        }
      ],
      tabs: [
        {
          id: 1,
          windowId: 1,
          index: 0,
          chromeGroupId: 10,
          url: "https://work.example/",
          title: "Work",
          pinned: false,
          active: true,
          incognito: false as const,
          lastAccessed: 1
        },
        {
          id: 2,
          windowId: 1,
          index: 1,
          chromeGroupId: 11,
          url: "https://other.example/",
          title: "Other",
          pinned: false,
          active: false,
          incognito: false as const,
          lastAccessed: 2
        }
      ],
      groups: [
        {
          id: 10,
          windowId: 1,
          title: "Work",
          color: "blue" as const,
          collapsed: false,
          shared: false
        },
        {
          id: 11,
          windowId: 1,
          title: "Other",
          color: "grey" as const,
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    };
    const session = await createMemorySessionRepository().loadSession();
    const { inventory } = observeInventory(raw, session);
    const associations = reconstructAssociations(raw, configuration);
    const context = { configuration, ownership: {}, associations };

    const workSnapshot = captureSnapshot(
      { kind: "group", managedGroupId: workId },
      inventory,
      context,
      { id: createUuid(), name: "Work only", kind: "named", now: 1 }
    );
    expect(workSnapshot.groups).toHaveLength(1);
    expect(workSnapshot.groups[0]?.tabs.map((tab) => tab.url)).toEqual([
      "https://work.example/"
    ]);

    const browserSnapshot = captureSnapshot(
      { kind: "browser" },
      inventory,
      context,
      { id: createUuid(), name: "Browser", kind: "named", now: 1 }
    );
    const workGroup = browserSnapshot.groups.find(
      (group) => group.managedGroupId === workId
    );
    const otherGroup = browserSnapshot.groups.find(
      (group) => group.managedGroupId === fallbackId
    );
    expect(workGroup?.tabs.map((tab) => tab.url)).toEqual([
      "https://work.example/"
    ]);
    expect(otherGroup?.tabs.map((tab) => tab.url)).toEqual([
      "https://other.example/"
    ]);
  });
});
