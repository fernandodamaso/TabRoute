import { describe, expect, it } from "vitest";
import { createUuid } from "../../src/domain/ids";
import { captureSnapshot } from "../../src/snapshots/captureSnapshot";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { observeInventory } from "../../src/duplicates/observations";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";

describe("snapshot capture", () => {
  it("captures durable identity without Chrome runtime IDs", async () => {
    const configuration = createDefaultConfiguration(() =>
      createUuid()
    );
    const raw = {
      windows: [{ id: 1, focused: true, incognito: false as const, type: "normal" as const }],
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
    const snapshot = captureSnapshot(
      { kind: "browser" },
      inventory,
      { configuration, ownership: {} },
      { id: createUuid(), name: "Before action", kind: "checkpoint", now: 1 }
    );
    expect(snapshot.groups[0]?.managedGroupId).toBe(configuration.fallbackGroupId);
    expect(JSON.stringify(snapshot)).not.toMatch(/chrome(Tab|Group|Window)Id/);
    expect(JSON.stringify(snapshot)).not.toMatch(/\b(tabId|groupId|windowId)\b/);
  });
});
