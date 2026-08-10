// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App as PopupApp } from "../../entrypoints/popup/App";

it("opens the popup on Groups and removes the old placeholder", () => {
  render(<PopupApp />);
  expect(screen.getByRole("heading", { name: "Groups" })).toBeTruthy();
  expect(screen.queryByText("Automation is ready.")).toBeNull();
  expect(document.documentElement.getAttribute("data-manager-viewport")).toBe("520x600");
});

it("keeps header and primary navigation outside the page scroller", () => {
  render(<PopupApp />);
  const scroller = document.querySelector(".manager-page-scroll");
  expect(scroller).toBeTruthy();
  expect(scroller?.querySelector(".manager-header")).toBeNull();
  expect(scroller?.querySelector(".manager-primary-nav")).toBeNull();
});

it("exposes the four primary destinations", () => {
  render(<PopupApp />);
  expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
  for (const label of ["Groups", "Rules", "Activity", "Settings"])
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
});

it("changes the active route, heading, title, and focus target", async () => {
  const user = userEvent.setup();
  render(<PopupApp />);
  await user.click(screen.getByRole("button", { name: "Rules" }));
  expect(screen.getByRole("heading", { name: "Rules" })).toBeTruthy();
  expect(document.title).toBe("TabRoute — Rules");
  expect(screen.getByRole("button", { name: "Rules" }).getAttribute("aria-current")).toBe("page");
  expect(document.activeElement?.getAttribute("data-route-focus")).toBe("rules");
});
