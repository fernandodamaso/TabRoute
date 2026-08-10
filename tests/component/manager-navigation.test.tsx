// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ManagerApp } from "../../src/ui/manager/ManagerApp";

it("uses the same manager implementation for the options surface", () => {
  render(<ManagerApp surface="options" />);
  expect(screen.getByRole("heading", { name: "Groups" })).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
});

it("keeps keyboard order in the shell before page content", async () => {
  const user = userEvent.setup();
  render(<ManagerApp surface="popup" />);
  await user.tab();
  expect(document.activeElement?.getAttribute("data-route-focus")).toBe("groups");
  await user.tab();
  expect(document.activeElement?.getAttribute("data-route-focus")).toBe("rules");
});
