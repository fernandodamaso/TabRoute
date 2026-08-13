import { describe, expect, it } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { resolveDuplicate } from "../../src/duplicates/resolveDuplicate";
import { observeInventory } from "../../src/duplicates/observations";
import { createMemorySessionRepository } from "../../src/state/sessionRepository";
import type { TabSnapshot, UUID } from "../../src/domain/types";

const groupId = "00000000-0000-4000-8000-000000000002" as UUID;

function routableTab(id: number, overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    id,
    windowId: 1,
    index: id,
    chromeGroupId: -1,
    url: "https://example.com/page",
    status: "complete",
    title: "Example",
    pinned: false,
    active: false,
    incognito: false,
    lastAccessed: id,
    routing: { kind: "routable", url: "https://example.com/page" },
    ...overrides
  };
}

describe("controller duplicates", () => {
  it("allow policy leaves both tabs without a duplicate decision", async () => {
    const configuration = createDefaultConfiguration(
      () => "00000000-0000-4000-8000-000000000001"
    );
    const sessionRepo = createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    const inventory = observeInventory(
      {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 1,
            windowId: 1,
            index: 0,
            chromeGroupId: -1,
            url: "https://example.com/page",
            title: "A",
            pinned: false,
            active: true,
            incognito: false,
            lastAccessed: 1
          },
          {
            id: 2,
            windowId: 1,
            index: 1,
            chromeGroupId: -1,
            url: "https://example.com/page",
            title: "B",
            pinned: false,
            active: false,
            incognito: false,
            lastAccessed: 2
          }
        ],
        groups: [],
        capturedAt: 1
      },
      session
    ).inventory;
    const decision = resolveDuplicate({
      inventory,
      tabs: inventory.tabs,
      configuration,
      associations: [],
      session,
      rule: null,
      destination: groupId,
      destinationManaged: true,
      destinationGroup: configuration.groups[0] ?? null
    });
    expect(decision).toBeNull();
  });

  it("selects one survivor for duplicate candidates", async () => {
    const configuration = {
      ...createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001"),
      duplicateSettings: {
        ...createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001")
          .duplicateSettings,
        globalPolicy: { kind: "exactUrl" as const }
      }
    };
    const sessionRepo = createMemorySessionRepository();
    const session = await sessionRepo.loadSession();
    const tabs = [routableTab(1, { lastAccessed: 1 }), routableTab(2, { lastAccessed: 3 })];
    const inventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" as const }],
      tabs,
      groups: [],
      capturedAt: 1
    };
    const decision = resolveDuplicate({
      inventory,
      tabs,
      configuration,
      associations: [],
      session,
      rule: null,
      destination: "ungrouped",
      destinationManaged: false,
      destinationGroup: null
    });
    expect(decision?.survivor.id).toBe(2);
    expect(decision?.duplicatesToClose.map((tab) => tab.id)).toEqual([1]);
  });
});
