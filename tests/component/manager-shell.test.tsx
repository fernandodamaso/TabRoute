// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { App as PopupApp } from "../../entrypoints/popup/App";

const view = {
  width: 520,
  height: 600,
  headerHeight: 52,
  navigationHeight: 42,
  defaultRoute: "groups",
  routes: ["groups", "rules", "activity", "settings"] as const
};

beforeEach(() => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: (
        _message: unknown,
        callback?: (response: unknown) => void
      ) => callback?.({ ok: true, configuration, view })
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("opens the popup on Groups and removes the old placeholder", async () => {
  render(<PopupApp />);
  expect(await screen.findByRole("heading", { name: "Groups" })).toBeTruthy();
  expect(screen.queryByText("Automation is ready.")).toBeNull();
  expect(document.documentElement.getAttribute("data-manager-viewport")).toBe(
    "520x600"
  );
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

it("rejects historical Quick Actions, Templates, Suggestions, and fifth nav", () => {
  render(<PopupApp />);
  const nav = screen.getByRole("navigation", { name: "Primary" });
  expect(nav.querySelectorAll("button")).toHaveLength(4);
  expect(screen.queryByRole("button", { name: "Quick Actions" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Templates" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Suggestions" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Persistent tabs" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Quick Actions" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Templates" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Suggestions" })).toBeNull();
  expect(document.body.textContent).not.toMatch(
    /Quick Actions|Templates|Suggestions/
  );
});

it("changes the active route, heading, title, and focus target", async () => {
  const user = userEvent.setup();
  render(<PopupApp />);
  await screen.findByRole("heading", { name: "Groups" });
  await user.click(screen.getByRole("button", { name: "Rules" }));
  expect(screen.getByRole("heading", { name: "Rules" })).toBeTruthy();
  expect(document.title).toBe("TabRoute — Rules");
  expect(
    screen.getByRole("button", { name: "Rules" }).getAttribute("aria-current")
  ).toBe("page");
  expect(document.activeElement?.getAttribute("data-route-focus")).toBe(
    "rules"
  );
});
