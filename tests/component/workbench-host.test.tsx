// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { App as OptionsApp } from "../../entrypoints/options/App";
import { App as PopupApp } from "../../entrypoints/popup/App";
import { WorkbenchOptionsApp } from "../../src/workbench/WorkbenchOptionsApp";

const DEFAULT_SEARCH = "?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none";

function setSearch(search: string) {
  window.history.replaceState({}, "", `/options.html${search}`);
}

beforeEach(() => {
  setSearch(DEFAULT_SEARCH);
  vi.restoreAllMocks();
});

it("exposes the workbench controls outside an exact 520 by 600 preview", async () => {
  render(<WorkbenchOptionsApp />);

  expect(screen.getByTestId("workbench-preview").getAttribute("data-preview-width")).toBe("520");
  expect(screen.getByTestId("workbench-preview").getAttribute("data-preview-height")).toBe("600");
  expect((screen.getByTestId("workbench-preview") as HTMLElement).style.width).toBe("520px");
  expect((screen.getByTestId("workbench-preview") as HTMLElement).style.height).toBe("600px");
  for (const control of [
    "mode", "scenario", "route", "deep-link", "latency", "failure-mode", "failure-scope",
    "command-log", "screenshot-status", "result-status", "reset"
  ]) {
    expect(document.querySelector(`[data-workbench-control="${control}"]`)).toBeTruthy();
  }
  expect(await screen.findByRole("heading", { name: "Groups" })).toBeTruthy();
});

it("synchronizes validated route changes with history.replaceState and focuses the manager route", async () => {
  const user = userEvent.setup();
  const replaceState = vi.spyOn(window.history, "replaceState");
  render(<WorkbenchOptionsApp />);

  await user.selectOptions(screen.getByLabelText("Route"), "rules");

  await waitFor(() => expect(screen.getByRole("heading", { name: "Rules" })).toBeTruthy());
  expect(replaceState).toHaveBeenCalled();
  expect(window.location.search).toContain("route=rules");
  await waitFor(() => expect(document.activeElement?.getAttribute("data-route-focus")).toBe("rules"));
});

it("keeps the loading marker pending until the fixture response is released", async () => {
  setSearch("?workbench=1&mode=fixture&route=groups&scenario=wb%3Aloading&deep-link=none&latency=0&failure=none");
  const user = userEvent.setup();
  render(<WorkbenchOptionsApp />);

  expect(await screen.findByText("Loading")).toBeTruthy();
  expect(document.querySelector('[data-workbench-status="manager-pending"]')).toBeTruthy();
  const release = screen.getByRole("button", { name: "Release pending response" });
  expect((release as HTMLButtonElement).disabled).toBe(false);

  await user.click(release);

  await waitFor(() => expect(document.querySelector('[data-workbench-status="manager-ready"]')).toBeTruthy());
  expect(screen.getByRole("heading", { name: "Groups" })).toBeTruthy();
});

it("opens the selected deep-link editor and confirmation dialog", async () => {
  setSearch("?workbench=1&mode=fixture&route=rules&scenario=wb%3Aedit-rule&deep-link=edit-rule%3A00000000-0000-4000-8000-000000000101&latency=0&failure=none");
  const { unmount } = render(<WorkbenchOptionsApp />);
  expect(await screen.findByRole("heading", { name: "Edit rule" })).toBeTruthy();
  unmount();

  setSearch("?workbench=1&mode=fixture&route=rules&scenario=wb%3Aconfirmation-overlay&deep-link=confirm-delete%3A00000000-0000-4000-8000-000000000101&latency=0&failure=none");
  render(<WorkbenchOptionsApp />);
  expect(await screen.findByRole("dialog", { name: "Delete rule?" })).toBeTruthy();
});

it("does not expose workbench markers or controls on popup and normal options surfaces", () => {
  const { unmount } = render(<PopupApp />);
  expect(document.querySelector('[data-workbench-marker="TABROUTE_DEV_WORKBENCH_V1"]')).toBeNull();
  expect(document.querySelector("[data-workbench-control]")).toBeNull();
  unmount();

  render(<OptionsApp />);
  expect(document.querySelector('[data-workbench-marker="TABROUTE_DEV_WORKBENCH_V1"]')).toBeNull();
  expect(document.querySelector("[data-workbench-control]")).toBeNull();
});
