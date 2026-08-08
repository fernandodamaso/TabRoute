// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { App } from "../../entrypoints/options/App";

beforeEach(() => {
  vi.stubGlobal("crypto", {
    randomUUID: () => "00000000-0000-4000-8000-000000000099"
  });
});

async function addRule() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Add rule" }));
  return user;
}

it("authors every schema-supported leaf with valid operators and operands", async () => {
  const user = await addRule();
  const field = screen.getByRole("combobox", { name: "Condition field" });

  const operators: Record<string, string[]> = {
    url: ["exact", "pattern", "regex"],
    host: ["exact", "suffix"],
    path: ["exact", "prefix"],
    title: ["contains", "exact", "regex"],
    openerUrl: ["exact", "pattern", "suffix"],
    openerHost: ["exact", "pattern", "suffix"]
  };
  for (const kind of Object.keys(operators)) {
    await user.selectOptions(field, kind);
    const operator = screen.getByRole("combobox", {
      name: "Condition operator"
    }) as HTMLSelectElement;
    expect(Array.from(operator.options).map((option) => option.value)).toEqual(
      operators[kind]
    );
    await user.selectOptions(
      operator,
      operators[kind]![operators[kind]!.length - 1]!
    );
    expect(
      screen.getByRole("textbox", { name: "Condition operand" })
    ).toBeTruthy();
  }

  await user.selectOptions(field, "pinned");
  expect(screen.getByRole("checkbox", { name: "Pinned value" })).toBeTruthy();
  expect(
    screen.queryByRole("textbox", { name: "Condition operand" })
  ).toBeNull();

  await user.selectOptions(field, "currentGroup");
  expect(
    screen.getByRole("combobox", { name: "Current placement" })
  ).toBeTruthy();
  expect(screen.getByRole("option", { name: "Ungrouped" })).toBeTruthy();
  expect(
    screen.getByRole("option", { name: "Unmanaged native group" })
  ).toBeTruthy();
});

it("authors bounded action choices while preventing illegal ungroup combinations", async () => {
  const user = await addRule();
  const placement = screen.getByRole("combobox", { name: "Placement action" });
  const persistent = screen.getByRole("checkbox", { name: "Make persistent" });
  const duplicate = screen.getByRole("combobox", {
    name: "Duplicate policy action"
  });
  const collapse = screen.getByRole("combobox", { name: "Collapse action" });

  await user.selectOptions(placement, "group");
  await user.click(persistent);
  await user.selectOptions(duplicate, "exactUrl");
  await user.selectOptions(collapse, "collapsed");
  expect((persistent as HTMLInputElement).checked).toBe(true);
  expect((duplicate as HTMLSelectElement).value).toBe("exactUrl");
  expect((collapse as HTMLSelectElement).value).toBe("collapsed");

  await user.selectOptions(duplicate, "pattern");
  expect(
    (
      screen.getByRole("textbox", {
        name: "Duplicate pattern"
      }) as HTMLInputElement
    ).value
  ).toBe("example.com/*");

  await user.selectOptions(placement, "ungroup");
  expect((persistent as HTMLInputElement).disabled).toBe(true);
  expect((collapse as HTMLSelectElement).disabled).toBe(true);
  expect((duplicate as HTMLSelectElement).disabled).toBe(false);
});

it("authors nested AND and OR groups at depth and changes an expression operator", async () => {
  const user = await addRule();
  const root = screen.getByRole("group", { name: "ALL group" });

  await user.click(
    within(root).getByRole("button", { name: "Add nested AND" })
  );
  const nestedAnd = screen.getAllByRole("group", { name: "ALL group" })[1]!;
  await user.click(
    within(nestedAnd).getByRole("button", { name: "Add nested OR" })
  );

  expect(screen.getAllByRole("group", { name: "ALL group" }).length).toBe(2);
  expect(screen.getAllByRole("group", { name: "ANY group" }).length).toBe(1);

  await user.selectOptions(
    within(root).getAllByRole("combobox", { name: "Expression operator" })[0]!,
    "any"
  );
  expect(screen.getAllByRole("group", { name: "ANY group" }).length).toBe(2);
});

it("rejects an invalid regular expression before save can replace configuration", async () => {
  const user = await addRule();
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Condition field" }),
    "url"
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Condition operator" }),
    "regex"
  );
  const operand = screen.getByRole("textbox", { name: "Condition operand" });
  await user.clear(operand);
  fireEvent.change(operand, { target: { value: "[" } });
  await user.click(screen.getByRole("button", { name: "Save configuration" }));

  expect(screen.getByRole("status").textContent).toMatch(
    /invalid regular expression/i
  );
});

it("deletes a rule through an explicit accessible action", async () => {
  const user = await addRule();
  const ruleCard = screen.getByRole("group", { name: /Rule 00000000/ });

  await user.click(within(ruleCard).getByRole("button", { name: "Delete rule" }));

  expect(screen.queryByRole("group", { name: /Rule 00000000/ })).toBeNull();
});

it("supports timed and restart pauses, and clearing, at every configured scope", async () => {
  const user = await addRule();
  const scopes = [
    ["Global pause", "Global pause minutes"],
    ["Group pause", "Group pause minutes"],
    ["Rule pause", "Rule pause minutes"]
  ] as const;

  for (const [scope, minutesLabel] of scopes) {
    const pause = screen.getByRole("combobox", { name: scope });
    await user.selectOptions(pause, "timed");
    const minutes = screen.getByRole("spinbutton", { name: minutesLabel }) as HTMLInputElement;
    expect(minutes.value).toBe("30");
    await user.selectOptions(pause, "restart");
    expect((pause as HTMLSelectElement).value).toBe("restart");
    await user.selectOptions(pause, "none");
    expect((pause as HTMLSelectElement).value).toBe("none");
    expect(screen.queryByRole("spinbutton", { name: minutesLabel })).toBeNull();
  }
});
