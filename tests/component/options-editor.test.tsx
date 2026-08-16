// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { App } from "../../entrypoints/options/App";

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

it("uses the shared manager and opens Groups first", async () => {
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Groups" })).toBeTruthy();
  expect(screen.queryByText("Managed groups and rules")).toBeNull();
});

it("opens the flat Rules editor from the shared options manager", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Rules" }));
  await user.click(await screen.findByRole("button", { name: "Add rule" }));
  expect(screen.getByRole("heading", { name: "New rule" })).toBeTruthy();
  expect(screen.getByText("IF")).toBeTruthy();
});
