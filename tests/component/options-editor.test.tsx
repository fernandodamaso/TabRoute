// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../../entrypoints/options/App";

it("uses the shared manager and opens Groups first", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Groups" })).toBeTruthy();
  expect(screen.queryByText("Managed groups and rules")).toBeNull();
});

it("opens the flat Rules editor from the shared options manager", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Rules" }));
  await user.click(screen.getByRole("button", { name: "Add rule" }));
  expect(screen.getByRole("heading", { name: "New rule" })).toBeTruthy();
  expect(screen.getByText("IF")).toBeTruthy();
});
