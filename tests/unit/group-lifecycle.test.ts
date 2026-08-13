import { describe, expect, it } from "vitest";
import {
  GROUP_SETTLEMENT_ALARM,
  settlePendingGroupRemovals,
  startPendingGroupRemoval
} from "../../src/groups/groupLifecycle";
import { createEmptyRuntimeSession } from "../../src/state/runtimeSession";
import type {
  BrowserSessionId,
  ChromeInventory,
  Configuration,
  RuntimeSession,
  UUID
} from "../../src/domain/types";
import { createDefaultConfiguration } from "../../src/domain/defaults";

const sessionId = "session-a" as BrowserSessionId;
const managedGroupId = "00000000-0000-4000-8000-000000000002" as UUID;

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    ...createEmptyRuntimeSession({ browserSessionId: sessionId }),
    ...overrides
  };
}

function configuration(persistent = false): Configuration {
  const base = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  return {
    ...base,
    groups: [
      ...base.groups,
      {
        schemaVersion: 1,
        id: managedGroupId,
        name: "Docs",
        color: "blue",
        isFallback: false,
        enabled: true,
        isPersistent: persistent,
        defaultOrder: 1,
        defaultCollapsed: false,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  };
}

describe("group lifecycle settlement", () => {
  it("does not write intentionallyClosedGroupIds on removal alone", () => {
    const before: ChromeInventory = {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [
        {
          id: 7,
          windowId: 1,
          index: 0,
          chromeGroupId: 11,
          url: "https://docs.example.com/",
          title: "Docs",
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
    };
    const next = startPendingGroupRemoval({
      session: session({
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: ["https://docs.example.com/"],
            observedAt: 1
          }
        ]
      }),
      inventoryBeforeRemoval: before,
      removed: before.groups[0]!,
      now: 100
    });
    expect(next.pendingGroupRemovals).toHaveLength(1);
    expect(next.intentionallyClosedGroupIds).toEqual([]);
  });

  it("reconstructs a unique cross-window match", () => {
    const pending = startPendingGroupRemoval({
      session: session({
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: ["https://docs.example.com/"],
            observedAt: 1
          }
        ]
      }),
      inventoryBeforeRemoval: {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 7,
            windowId: 1,
            index: 0,
            chromeGroupId: 11,
            url: "https://docs.example.com/",
            title: "Docs",
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
      },
      removed: {
        id: 11,
        windowId: 1,
        title: "Docs",
        color: "blue",
        collapsed: false,
        shared: false
      },
      now: 100
    });
    const after: ChromeInventory = {
      windows: [
        { id: 1, focused: false, incognito: false, type: "normal" },
        { id: 2, focused: true, incognito: false, type: "normal" }
      ],
      tabs: [
        {
          id: 7,
          windowId: 2,
          index: 0,
          chromeGroupId: 22,
          url: "https://docs.example.com/",
          title: "Docs",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 2
        }
      ],
      groups: [
        {
          id: 22,
          windowId: 2,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 2
    };
    const next = settlePendingGroupRemovals({
      session: pending,
      inventory: after,
      configuration: configuration(),
      now: 900
    });
    expect(next.pendingGroupRemovals).toHaveLength(0);
    expect(next.associations[0]).toMatchObject({
      managedGroupId,
      chromeGroupId: 22,
      chromeWindowId: 2
    });
  });

  it("leaves two same-title groups unattached", () => {
    const pending = startPendingGroupRemoval({
      session: session({
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: ["https://docs.example.com/"],
            observedAt: 1
          }
        ]
      }),
      inventoryBeforeRemoval: {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 7,
            windowId: 1,
            index: 0,
            chromeGroupId: 11,
            url: "https://docs.example.com/",
            title: "Docs",
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
      },
      removed: {
        id: 11,
        windowId: 1,
        title: "Docs",
        color: "blue",
        collapsed: false,
        shared: false
      },
      now: 100
    });
    const after: ChromeInventory = {
      windows: [
        { id: 2, focused: true, incognito: false, type: "normal" },
        { id: 3, focused: false, incognito: false, type: "normal" }
      ],
      tabs: [
        {
          id: 7,
          windowId: 2,
          index: 0,
          chromeGroupId: 21,
          url: "https://docs.example.com/",
          title: "Docs",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 2
        },
        {
          id: 8,
          windowId: 3,
          index: 0,
          chromeGroupId: 31,
          url: "https://docs.example.com/",
          title: "Docs copy",
          pinned: false,
          active: false,
          incognito: false,
          lastAccessed: 2
        }
      ],
      groups: [
        {
          id: 21,
          windowId: 2,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        },
        {
          id: 31,
          windowId: 3,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 2
    };
    const next = settlePendingGroupRemovals({
      session: pending,
      inventory: after,
      configuration: configuration(),
      now: 900
    });
    expect(next.pendingGroupRemovals).toHaveLength(1);
    expect(next.associations[0]?.chromeGroupId).toBe(11);
  });

  it("ignores shared groups as reconstruction candidates", () => {
    const pending = startPendingGroupRemoval({
      session: session({
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: ["https://docs.example.com/"],
            observedAt: 1
          }
        ]
      }),
      inventoryBeforeRemoval: {
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
      },
      removed: {
        id: 11,
        windowId: 1,
        title: "Docs",
        color: "blue",
        collapsed: false,
        shared: false
      },
      now: 100
    });
    const after: ChromeInventory = {
      windows: [{ id: 2, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [
        {
          id: 22,
          windowId: 2,
          title: "Docs",
          color: "blue",
          collapsed: false,
          shared: true
        }
      ],
      capturedAt: 2
    };
    const next = settlePendingGroupRemovals({
      session: pending,
      inventory: after,
      configuration: configuration(true),
      now: 900
    });
    expect(next.intentionallyClosedGroupIds).toContain(managedGroupId);
  });

  it("writes intentional close marker for persistent settled absence", () => {
    const pending = startPendingGroupRemoval({
      session: session({
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: [],
            observedAt: 1
          }
        ]
      }),
      inventoryBeforeRemoval: {
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
      },
      removed: {
        id: 11,
        windowId: 1,
        title: "Docs",
        color: "blue",
        collapsed: false,
        shared: false
      },
      now: 100
    });
    const next = settlePendingGroupRemovals({
      session: pending,
      inventory: {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 2
      },
      configuration: configuration(true),
      now: 900
    });
    expect(next.intentionallyClosedGroupIds).toContain(managedGroupId);
    expect(next.pendingGroupRemovals).toHaveLength(0);
  });

  it("clears pending without close marker for non-persistent settled absence", () => {
    const pending = startPendingGroupRemoval({
      session: session({
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: [],
            observedAt: 1
          }
        ]
      }),
      inventoryBeforeRemoval: {
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
      },
      removed: {
        id: 11,
        windowId: 1,
        title: "Docs",
        color: "blue",
        collapsed: false,
        shared: false
      },
      now: 100
    });
    const next = settlePendingGroupRemovals({
      session: pending,
      inventory: {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [],
        groups: [],
        capturedAt: 2
      },
      configuration: configuration(false),
      now: 900
    });
    expect(next.intentionallyClosedGroupIds).toEqual([]);
    expect(next.pendingGroupRemovals).toHaveLength(0);
  });

  it("does not write intentionallyClosedGroupIds when no normal windows remain", () => {
    const pending = startPendingGroupRemoval({
      session: session({
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: [],
            observedAt: 1
          }
        ]
      }),
      inventoryBeforeRemoval: {
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
      },
      removed: {
        id: 11,
        windowId: 1,
        title: "Docs",
        color: "blue",
        collapsed: false,
        shared: false
      },
      now: 100
    });
    const next = settlePendingGroupRemovals({
      session: pending,
      inventory: {
        windows: [],
        tabs: [],
        groups: [],
        capturedAt: 2
      },
      configuration: configuration(true),
      now: 900
    });
    expect(next.intentionallyClosedGroupIds).toEqual([]);
    expect(next.pendingGroupRemovals).toHaveLength(0);
  });

  it("requires member evidence inside the candidate group", () => {
    const pending = startPendingGroupRemoval({
      session: session({
        associations: [
          {
            managedGroupId,
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Docs",
            observedMemberUrls: ["https://docs.example.com/"],
            observedAt: 1
          }
        ]
      }),
      inventoryBeforeRemoval: {
        windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 7,
            windowId: 1,
            index: 0,
            chromeGroupId: 11,
            url: "https://docs.example.com/",
            title: "Docs",
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
      },
      removed: {
        id: 11,
        windowId: 1,
        title: "Docs",
        color: "blue",
        collapsed: false,
        shared: false
      },
      now: 100
    });
    const next = settlePendingGroupRemovals({
      session: pending,
      inventory: {
        windows: [{ id: 2, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 8,
            windowId: 2,
            index: 0,
            chromeGroupId: -1,
            url: "https://docs.example.com/",
            title: "Loose",
            pinned: false,
            active: true,
            incognito: false,
            lastAccessed: 2
          }
        ],
        groups: [
          {
            id: 22,
            windowId: 2,
            title: "Docs",
            color: "blue",
            collapsed: false,
            shared: false
          }
        ],
        capturedAt: 2
      },
      configuration: configuration(false),
      now: 900
    });
    expect(next.pendingGroupRemovals).toHaveLength(0);
    expect(next.associations[0]?.chromeGroupId).toBe(11);
    expect(next.intentionallyClosedGroupIds).toEqual([]);
  });
});

describe("GROUP_SETTLEMENT_ALARM", () => {
  it("exports the settlement alarm name", () => {
    expect(GROUP_SETTLEMENT_ALARM).toBe("tabroute:group-settlement");
  });
});
