// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createDefaultConfiguration, createManagedGroup } from "../../src/domain/defaults";
import { GroupsPage } from "../../src/ui/manager/pages/GroupsPage";
import type { ManagerCommand, ManagerResponse } from "../../src/ui/manager/types";

function setup() {
  const configuration = createManagedGroup(createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001"), { name: "Work", color: "blue" }, () => "00000000-0000-4000-8000-000000000002");
  const command = vi.fn(async (_message: ManagerCommand): Promise<ManagerResponse> => ({ ok: true, configuration, view: { width: 520, height: 600, headerHeight: 52, navigationHeight: 42, defaultRoute: "groups", routes: ["groups", "rules", "activity", "settings"] } }));
  return { configuration, command };
}

it("keeps the navigator fixed while the inspector owns scrolling", () => {
  const { configuration, command } = setup();
  render(<GroupsPage configuration={configuration} command={command} />);
  expect(document.querySelector(".groups-navigator")).toBeTruthy();
  expect(document.querySelector(".groups-inspector")).toBeTruthy();
  expect(document.querySelector(".groups-navigator")?.classList.contains("groups-scroll-owner")).toBe(false);
  expect(document.querySelector(".groups-inspector")?.classList.contains("groups-scroll-owner")).toBe(true);
});

it("exposes group identity, color, emoji, enablement, and fallback protection", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  render(<GroupsPage configuration={configuration} command={command} />);
  expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Emoji" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Chrome color" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Group On" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Other/ }));
  expect((screen.getByRole("checkbox", { name: "Group On" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("Fallback group")).toBeTruthy();
});

it("sends immediate typed commands for toggles and exposes persistent-tab states", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  render(<GroupsPage configuration={configuration} command={command} />);
  await user.click(screen.getByRole("button", { name: "Work" }));
  await user.click(screen.getByRole("checkbox", { name: "Group On" }));
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: "updateGroup", patch: { enabled: false } }) }));
  expect(screen.getByRole("heading", { name: "Persistent tabs" })).toBeTruthy();
  expect(screen.getByText("No persistent tabs")).toBeTruthy();
});

it("supports group creation and deletion through typed commands", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  render(<GroupsPage configuration={configuration} command={command} />);
  await user.click(screen.getByRole("button", { name: "Work" }));
  await user.click(screen.getByRole("button", { name: "Add group" }));
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: "createGroup" }) }));
  await user.click(screen.getByRole("button", { name: /Delete group/ }));
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: "deleteGroup" }) }));
});
