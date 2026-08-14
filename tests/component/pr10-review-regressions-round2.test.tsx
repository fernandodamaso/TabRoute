// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createManagerMessageRouter } from "../../src/background/managerMessageRouter";
import {
  createDefaultConfiguration,
  createManagedGroup
} from "../../src/domain/defaults";
import type { Configuration, ManagedGroup, UUID } from "../../src/domain/types";
import { SettingsPage } from "../../src/ui/manager/pages/SettingsPage";
import { SnapshotsPage } from "../../src/ui/manager/pages/SnapshotsPage";
import type {
  ManagerCommandPayload,
  ManagerResponse
} from "../../src/ui/manager/types";

const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
const groupId = "00000000-0000-4000-8000-000000000002" as UUID;

function success(configuration: Configuration): ManagerResponse {
  return {
    ok: true,
    configuration,
    view: {
      width: 520,
      height: 600,
      headerHeight: 52,
      navigationHeight: 42,
      defaultRoute: "groups",
      routes: ["groups", "rules", "activity", "settings"]
    }
  };
}

function routerDependencies(configuration: Configuration) {
  let current = configuration;
  return {
    repository: {
      save: async (next: Configuration) => {
        current = next;
      }
    },
    controller: {
      getConfiguration: () => current,
      replaceConfiguration: async (next: Configuration) => {
        current = next;
      }
    },
    activity: {
      query: async () => ({ persistentTabsByGroup: {}, activity: [] }),
      undo: async () => undefined,
      clear: async () => undefined
    },
    snapshots: {
      query: async () => ({ persistentTabsByGroup: {}, snapshots: [] }),
      save: async () => success(current),
      restore: async () => success(current),
      update: async () => success(current),
      rename: async () => success(current),
      delete: async () => success(current)
    },
    diagnostics: {
      query: async () => ({ persistentTabsByGroup: {} }),
      recheck: async () => ({ persistentTabsByGroup: {} }),
      retryPendingSync: async () => ({ persistentTabsByGroup: {} }),
      reconcileAll: async () => undefined,
      exportActivityLog: async () => ({ persistentTabsByGroup: {} })
    },
    getConfiguration: () => current
  };
}

describe("PR 10 remaining manager review regressions", () => {
  it("propagates unavailable Undo instead of reporting manager success", async () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const deps = routerDependencies(configuration);
    const router = createManagerMessageRouter({
      ...deps,
      activity: {
        ...deps.activity,
        undo: async () => "unavailable"
      }
    } as never);

    const response = await router.handle({
      kind: "manager-command",
      command: {
        kind: "undo",
        undoId: "00000000-0000-4000-8000-000000000090" as UUID
      }
    });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("UNDO_UNAVAILABLE");
  });

  it("reschedules snapshot alarms after a local interval change", async () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const deps = routerDependencies(configuration);
    const refreshAlarms = vi.fn(async (_next: Configuration) => undefined);
    const router = createManagerMessageRouter({
      ...deps,
      refreshAlarms
    } as never);

    const response = await router.handle({
      kind: "manager-command",
      command: { kind: "setSnapshotIntervalMinutes", minutes: 5 }
    });

    expect(response.ok).toBe(true);
    expect(refreshAlarms).toHaveBeenCalledTimes(1);
    expect(refreshAlarms.mock.calls[0]?.[0].snapshotIntervalMinutes).toBe(5);
  });

  it("exports the fresh configuration returned by the background", async () => {
    const user = userEvent.setup();
    const stale = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const fresh: Configuration = { ...stale, automationEnabled: false };
    let exportedBlob: Blob | undefined;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        exportedBlob = blob;
        return "blob:test";
      })
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string) => {
        const element = originalCreateElement(tagName);
        if (tagName === "a") element.click = vi.fn();
        return element;
      }
    );
    render(
      <SettingsPage
        configuration={stale}
        command={async () => success(fresh)}
        onOpenSnapshots={() => undefined}
        onOpenDiagnostics={() => undefined}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Export configuration" })
    );

    expect(exportedBlob).toBeTruthy();
    const exported = JSON.parse(await exportedBlob!.text()) as Configuration;
    expect(exported.automationEnabled).toBe(false);
  });

  it("synchronizes the interval draft after imported configuration changes", () => {
    const configuration = createDefaultConfiguration(
      () => fallbackId,
      () => 1
    );
    const props = {
      command: async (_payload: ManagerCommandPayload) =>
        success(configuration),
      onOpenSnapshots: () => undefined,
      onOpenDiagnostics: () => undefined
    };
    const { rerender } = render(
      <SettingsPage configuration={configuration} {...props} />
    );
    const interval = screen.getByRole("spinbutton", {
      name: "Snapshot interval minutes"
    }) as HTMLInputElement;
    expect(interval.value).toBe("60");

    rerender(
      <SettingsPage
        configuration={{ ...configuration, snapshotIntervalMinutes: 15 }}
        {...props}
      />
    );

    expect(interval.value).toBe("15");
  });

  it("exposes and edits the global pattern duplicate policy", async () => {
    const user = userEvent.setup();
    const configuration: Configuration = {
      ...createDefaultConfiguration(
        () => fallbackId,
        () => 1
      ),
      duplicateSettings: {
        globalPolicy: { kind: "pattern", pattern: "https://*.example.com/*" },
        globalExclusions: [],
        trackingParameters: []
      }
    };
    const command = vi.fn(
      async (_payload: ManagerCommandPayload): Promise<ManagerResponse> =>
        success(configuration)
    );
    render(
      <SettingsPage
        configuration={configuration}
        command={command}
        onOpenSnapshots={() => undefined}
        onOpenDiagnostics={() => undefined}
      />
    );

    const policy = screen.getByRole("combobox", {
      name: "Duplicate policy"
    }) as HTMLSelectElement;
    expect(policy.value).toBe("pattern");
    const pattern = screen.getByRole("textbox", {
      name: "Duplicate pattern"
    }) as HTMLInputElement;
    expect(pattern.value).toBe("https://*.example.com/*");
    await user.clear(pattern);
    await user.type(pattern, "https://docs.example.com/*");
    await user.tab();

    expect(command).toHaveBeenCalledWith({
      kind: "setDuplicateSettings",
      settings: {
        ...configuration.duplicateSettings,
        globalPolicy: {
          kind: "pattern",
          pattern: "https://docs.example.com/*"
        }
      }
    });
  });

  it("offers named snapshot capture for an individual managed group", async () => {
    const user = userEvent.setup();
    const configuration = createManagedGroup(
      createDefaultConfiguration(
        () => fallbackId,
        () => 1
      ),
      { name: "Work", color: "blue" },
      () => groupId,
      () => 1
    );
    const group = configuration.groups.find(
      (candidate) => candidate.id === groupId
    ) as ManagedGroup;
    const command = vi.fn(
      async (_payload: ManagerCommandPayload): Promise<ManagerResponse> =>
        success(configuration)
    );
    const props = {
      snapshots: [],
      command,
      onBack: () => undefined,
      groups: [group]
    } as unknown as Parameters<typeof SnapshotsPage>[0];
    render(<SnapshotsPage {...props} />);

    await user.type(
      screen.getByRole("textbox", { name: "Snapshot name" }),
      "Work only"
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Snapshot scope" }),
      groupId
    );
    await user.click(screen.getByRole("button", { name: "Save snapshot" }));

    expect(command).toHaveBeenCalledWith({
      kind: "saveSnapshot",
      name: "Work only",
      scope: { kind: "group", managedGroupId: groupId }
    });
  });
});
