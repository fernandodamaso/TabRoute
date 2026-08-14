// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { RulesOverview } from "../../src/ui/manager/rules/RulesOverview";
import type { Configuration, UUID } from "../../src/domain/types";
import type {
  ManagerCommand,
  ManagerResponse
} from "../../src/ui/manager/types";

function config(): Configuration {
  const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
  return {
    ...createDefaultConfiguration(() => fallbackId),
    rules: [
      {
        schemaVersion: 1,
        id: "00000000-0000-4000-8000-000000000010" as UUID,
        targetGroupId: fallbackId,
        priority: 1,
        positive: { kind: "host", operator: "exact", value: "example.com" },
        negative: [],
        actions: [{ kind: "group" }],
        enabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  };
}

it("cancels delete without a command and confirms once with focus restoration", async () => {
  const user = userEvent.setup();
  const command = vi.fn(
    async (_message: ManagerCommand): Promise<ManagerResponse> => ({
      ok: true,
      configuration: config(),
      view: {
        width: 520,
        height: 600,
        headerHeight: 52,
        navigationHeight: 42,
        defaultRoute: "groups",
        routes: ["groups", "rules", "activity", "settings"]
      }
    })
  );
  render(<RulesOverview configuration={config()} command={command} />);
  const trigger = screen.getByRole("button", { name: /Rule actions/ });
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", { name: "Delete" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(command).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", { name: "Delete" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", { name: "Delete" }));
  await user.click(screen.getByRole("button", { name: "Delete rule" }));
  expect(command).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(trigger);
});

it("roves menu focus and traps dialog focus at both ends", async () => {
  const user = userEvent.setup();
  const command = vi.fn(
    async (_message: ManagerCommand): Promise<ManagerResponse> => ({
      ok: true,
      configuration: config(),
      view: {
        width: 520,
        height: 600,
        headerHeight: 52,
        navigationHeight: 42,
        defaultRoute: "groups",
        routes: ["groups", "rules", "activity", "settings"]
      }
    })
  );
  render(<RulesOverview configuration={config()} command={command} />);
  const trigger = screen.getByRole("button", { name: /Rule actions/ });
  await user.click(trigger);
  const menuItems = screen.getAllByRole("menuitem");
  expect(document.activeElement).toBe(menuItems[0]);
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(menuItems[1]);
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(menuItems[0]);
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(menuItems[2]);
  await user.click(menuItems[2]!);

  const dialog = screen.getByRole("dialog");
  const dialogButtons = Array.from(dialog.querySelectorAll("button"));
  expect(document.activeElement).toBe(dialogButtons[0]);
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(dialogButtons[1]);
  await user.keyboard("{Tab}");
  expect(document.activeElement).toBe(dialogButtons[0]);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
