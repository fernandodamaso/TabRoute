// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { RuleEditorPage } from "../../src/ui/manager/pages/RuleEditorPage";
import type { ManagerCommand, ManagerResponse } from "../../src/ui/manager/types";

function setup() {
  const configuration = createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001");
  const command = vi.fn(async (_message: ManagerCommand): Promise<ManagerResponse> => ({ ok: true, configuration, view: { width: 520, height: 600, headerHeight: 52, navigationHeight: 42, defaultRoute: "groups", routes: ["groups", "rules", "activity", "settings"] } }));
  return { configuration, command };
}

it("renders IF, AND, NOT, and one THEN outcome without nested groups", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  render(<RuleEditorPage configuration={configuration} command={command} onCancel={vi.fn()} />);
  expect(screen.getByText("IF")).toBeTruthy();
  expect(screen.getByText("THEN")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Add condition" }));
  await user.click(screen.getByRole("button", { name: "Add exception" }));
  expect(screen.getByText("AND")).toBeTruthy();
  expect(screen.getByText("NOT")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Add nested|Add OR/ })).toBeNull();
});

it("saves once after validation and Cancel discards without a command", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  const onCancel = vi.fn();
  const onSaved = vi.fn();
  render(<RuleEditorPage configuration={configuration} command={command} onCancel={onCancel} onSaved={onSaved} />);
  await user.click(screen.getByRole("button", { name: "Save rule" }));
  expect(command).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
});

it("blocks invalid regular expressions and focuses the first error", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  render(<RuleEditorPage configuration={configuration} command={command} onCancel={vi.fn()} />);
  await user.selectOptions(screen.getByRole("combobox", { name: "Condition field 1" }), "url");
  await user.selectOptions(screen.getByRole("combobox", { name: "Condition operator 1" }), "regex");
  const operand = screen.getByRole("textbox", { name: "Condition value 1" });
  await user.clear(operand);
  fireEvent.change(operand, { target: { value: "[" } });
  await user.click(screen.getByRole("button", { name: "Save rule" }));
  expect(command).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(document.activeElement).toBe(operand);
});

it("edits bounded THEN actions and preserves the duplicate pattern", async () => {
  const user = userEvent.setup();
  const { configuration, command } = setup();
  render(<RuleEditorPage configuration={configuration} command={command} onCancel={vi.fn()} />);

  const placement = screen.getByRole("combobox", { name: "Placement action" });
  const persistent = screen.getByRole("checkbox", { name: "Make persistent" });
  const collapse = screen.getByRole("combobox", { name: "Collapse action" });
  await user.selectOptions(placement, "ungroup");
  expect((persistent as HTMLInputElement).disabled).toBe(true);
  expect((collapse as HTMLSelectElement).disabled).toBe(true);
  await user.selectOptions(placement, "group");
  await user.click(persistent);
  await user.selectOptions(screen.getByRole("combobox", { name: "Duplicate policy action" }), "pattern");
  await user.type(screen.getByRole("textbox", { name: "Duplicate pattern" }), "docs/*");
  await user.selectOptions(collapse, "collapsed");
  await user.click(screen.getByRole("button", { name: "Save rule" }));

  expect(command).toHaveBeenCalledWith(expect.objectContaining({
    command: expect.objectContaining({
      kind: "saveRule",
      rule: expect.objectContaining({
        actions: [
          { kind: "group" },
          { kind: "makePersistent" },
          { kind: "setDuplicatePolicy", policy: { kind: "pattern", pattern: "docs/*" } },
          { kind: "setCollapsed", collapsed: true }
        ]
      })
    })
  }));
});
