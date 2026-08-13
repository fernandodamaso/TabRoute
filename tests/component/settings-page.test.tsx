// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import type { Configuration } from "../../src/domain/types";
import { SettingsPage } from "../../src/ui/manager/pages/SettingsPage";
import "../../src/ui/manager/manager.css";

const configuration = createDefaultConfiguration(
  () => "00000000-0000-4000-8000-000000000001"
);

function renderPage(overrides: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  const command = vi.fn(async () => undefined);
  render(
    <SettingsPage
      configuration={configuration}
      command={command}
      onOpenSnapshots={() => undefined}
      onOpenDiagnostics={() => undefined}
      {...overrides}
    />
  );
  return command;
}

it("renders automation and persistent startup controls", () => {
  renderPage();
  expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Enable automation" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Restore persistent groups" })).toBeTruthy();
});

it("sends settings commands for automation and duplicate policy", async () => {
  const user = userEvent.setup();
  const command = renderPage();
  await user.click(screen.getByRole("checkbox", { name: "Enable automation" }));
  expect(command).toHaveBeenCalledWith({ kind: "setAutomationEnabled", enabled: false });
  await user.selectOptions(screen.getByRole("combobox", { name: "Duplicate policy" }), "domain");
  expect(command).toHaveBeenCalledWith({
    kind: "setDuplicateSettings",
    settings: {
      ...configuration.duplicateSettings,
      globalPolicy: { kind: "domain" }
    }
  });
});

it("updates snapshot interval and opens subpanels", async () => {
  const user = userEvent.setup();
  const onOpenSnapshots = vi.fn();
  const onOpenDiagnostics = vi.fn();
  const command = renderPage({ onOpenSnapshots, onOpenDiagnostics });
  const interval = screen.getByRole("spinbutton", { name: "Snapshot interval minutes" });
  await user.clear(interval);
  await user.type(interval, "30");
  await user.tab();
  expect(command).toHaveBeenCalledWith({
    kind: "setSnapshotIntervalMinutes",
    minutes: 30
  });
  await user.click(screen.getByRole("button", { name: "Snapshots" }));
  await user.click(screen.getByRole("button", { name: "Diagnostics" }));
  expect(onOpenSnapshots).toHaveBeenCalled();
  expect(onOpenDiagnostics).toHaveBeenCalled();
});

it("exports configuration through a blob download", async () => {
  const user = userEvent.setup();
  const createObjectURL = vi.fn(() => "blob:test");
  const revokeObjectURL = vi.fn();
  const click = vi.fn();
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    const element = originalCreateElement(tagName);
    if (tagName === "a") element.click = click;
    return element;
  });
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
  const command = renderPage();
  await user.click(screen.getByRole("button", { name: "Export configuration" }));
  expect(command).toHaveBeenCalledWith({ kind: "exportConfiguration" });
  expect(createObjectURL).toHaveBeenCalled();
  expect(click).toHaveBeenCalled();
});

it("imports configuration from a selected file", async () => {
  const user = userEvent.setup();
  const command = renderPage();
  const payload: Configuration = {
    ...configuration,
    automationEnabled: false
  };
  const file = new File([JSON.stringify(payload)], "tabroute.json", {
    type: "application/json"
  });
  const input = document.querySelector('input[type="file"][aria-label="Import configuration"]') as HTMLInputElement;
  await user.upload(input, file);
  expect(command).toHaveBeenCalledWith({
    kind: "importConfiguration",
    json: JSON.stringify(payload)
  });
});
