import { beforeEach, expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import {
  refreshMenus,
  resetMenuRegistrationForTests,
  type MenuCommandHost
} from "../../src/background/registerMenus";

function createHost(): MenuCommandHost {
  const configuration = createDefaultConfiguration(
    () => "11111111-1111-4111-8111-111111111111"
  );
  return {
    async executeUserCommand() {
      return { ok: true };
    },
    async readMenuContext() {
      return {
        configuration,
        inventory: {
          capturedAt: 1,
          windows: [],
          tabs: [],
          groups: []
        },
        associations: [],
        checkpointInFlight: false,
        availableUndoId: undefined
      };
    }
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetMenuRegistrationForTests();
});

it("serializes overlapping menu refreshes so duplicate IDs are never created", async () => {
  const activeIds = new Set<string>();
  const duplicateAttempts: string[] = [];
  const runtime: { lastError?: { message: string } } = {};
  const browser = {
    runtime,
    contextMenus: {
      async removeAll() {
        await Promise.resolve();
        activeIds.clear();
      },
      create(
        props: chrome.contextMenus.CreateProperties,
        callback?: () => void
      ) {
        const id = String(props.id);
        if (activeIds.has(id)) {
          duplicateAttempts.push(id);
          runtime.lastError = {
            message: `Cannot create item with duplicate id ${id}`
          };
          callback?.();
          runtime.lastError = undefined;
          return id;
        }
        activeIds.add(id);
        callback?.();
        return id;
      }
    }
  } as unknown as typeof chrome;

  await Promise.all([
    refreshMenus(browser, createHost()),
    refreshMenus(browser, createHost())
  ]);

  expect(duplicateAttempts).toEqual([]);
  expect(activeIds).toContain("tabroute:create-rule");
  expect(activeIds).toContain("tabroute:save-snapshot");
});

it("rejects a refresh when Chrome reports a context-menu create error", async () => {
  const runtime: { lastError?: { message: string } } = {};
  const browser = {
    runtime,
    contextMenus: {
      async removeAll() {},
      create(
        props: chrome.contextMenus.CreateProperties,
        callback?: () => void
      ) {
        const id = String(props.id);
        runtime.lastError = { message: `create failed for ${id}` };
        callback?.();
        runtime.lastError = undefined;
        return id;
      }
    }
  } as unknown as typeof chrome;

  await expect(refreshMenus(browser, createHost())).rejects.toThrow(
    "create failed for tabroute:create-rule"
  );
});
