// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import type { Configuration, ManagedGroup, PersistentTab, UUID } from "../../src/domain/types";
import { GroupInspector } from "../../src/ui/manager/groups/GroupInspector";
import type { ManagerResponse } from "../../src/ui/manager/types";

const groupId = "00000000-0000-4000-8000-000000000002" as UUID;

describe("PersistentTabsSection", () => {
  it("lists persistent definitions and removes one", async () => {
    const command = vi.fn(async (): Promise<ManagerResponse> => ({
      ok: true,
      configuration: createDefaultConfiguration(),
      view: {
        width: 520,
        height: 600,
        headerHeight: 52,
        navigationHeight: 42,
        defaultRoute: "groups",
        routes: ["groups", "rules", "activity", "settings"]
      }
    }));
    const user = userEvent.setup();
    const persistentTab: PersistentTab = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000011" as UUID,
      managedGroupId: groupId,
      canonicalUrl: "https://docs.example.com/guide",
      acceptedPatterns: ["https://docs.example.com/guide"],
      order: 0,
      createdAt: 1,
      updatedAt: 1
    };
    const base = createDefaultConfiguration();
    const group: ManagedGroup = {
      schemaVersion: 1,
      id: groupId,
      name: "Docs",
      color: "blue",
      isFallback: false,
      enabled: true,
      isPersistent: true,
      defaultOrder: 1,
      defaultCollapsed: false,
      createdAt: 1,
      updatedAt: 1
    };
    const configuration: Configuration = {
      ...base,
      groups: [...base.groups, group],
      persistentTabs: [persistentTab]
    };
    render(
      <GroupInspector
        group={group}
        configuration={configuration}
        command={command}
      />
    );
    expect(screen.getByText("docs.example.com")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove docs.example.com" }));
    expect(command).toHaveBeenCalledWith({
      kind: "manager-command",
      command: { kind: "removePersistent", persistentTabId: persistentTab.id }
    });
  });
});
