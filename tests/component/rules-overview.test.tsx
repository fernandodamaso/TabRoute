// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { RulesOverview } from "../../src/ui/manager/rules/RulesOverview";
import type { Configuration, UUID } from "../../src/domain/types";
import type { ManagerCommand, ManagerResponse } from "../../src/ui/manager/types";

function setup() {
  const fallbackId = "00000000-0000-4000-8000-000000000001" as UUID;
  const configuration: Configuration = {
    ...createDefaultConfiguration(() => fallbackId),
    rules: [
      { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000010" as UUID, targetGroupId: fallbackId, priority: 20, positive: { kind: "host", operator: "exact", value: "example.com" }, negative: [], actions: [{ kind: "group" }], enabled: true, createdAt: 1, updatedAt: 1 },
      { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000011" as UUID, targetGroupId: fallbackId, priority: 10, positive: { kind: "title", operator: "contains", value: "Paused" }, negative: [], actions: [{ kind: "group" }], enabled: true, pausedUntil: "restart", createdAt: 1, updatedAt: 1 },
      { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000012" as UUID, targetGroupId: fallbackId, priority: 1, positive: { kind: "pinned", value: true }, negative: [], actions: [{ kind: "group" }], enabled: false, createdAt: 1, updatedAt: 1 }
    ]
  };
  const command = vi.fn(async (_message: ManagerCommand): Promise<ManagerResponse> => ({ ok: true, configuration, view: { width: 520, height: 600, headerHeight: 52, navigationHeight: 42, defaultRoute: "groups", routes: ["groups", "rules", "activity", "settings"] } }));
  return { configuration, command };
}

it("filters All, Active, Paused, and Off with controller-compatible status", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  render(<RulesOverview configuration={configuration} command={command} />);
  expect(screen.getByText("3 rules")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Active" }));
  expect(screen.getByText("1 rule")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Paused" }));
  expect(screen.getByText("1 rule")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Off" }));
  expect(screen.getByText("1 rule")).toBeTruthy();
});

it("shows rule details and routes enabled/paused changes through one command", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  render(<RulesOverview configuration={configuration} command={command} />);
  expect(screen.getByText("Priority 20")).toBeTruthy();
  expect(screen.getByText("example.com")).toBeTruthy();
  expect(screen.getAllByText("Other").length).toBeGreaterThan(0);
  const enabled = screen.getAllByRole("checkbox", { name: /Enabled/ })[0]!;
  await user.click(enabled);
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: "setRuleEnabled" }) }));
  await user.click(screen.getAllByRole("button", { name: /Pause rule/ })[0]!);
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: "setRulePaused" }) }));
});

it("duplicates through the background command and exposes Edit", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  const onEdit = vi.fn();
  render(<RulesOverview configuration={configuration} command={command} onEdit={onEdit} />);
  await user.click(screen.getAllByRole("button", { name: /Rule actions/ })[0]!);
  await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ kind: "duplicateRule" }) }));
  await user.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
  expect(onEdit).toHaveBeenCalled();
});
