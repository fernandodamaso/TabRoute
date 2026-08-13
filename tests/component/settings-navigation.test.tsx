// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import type { ManagerMessage, ManagerResponse, ManagerViewMetadata } from "../../src/ui/manager/types";
import { ManagerApp } from "../../src/ui/manager/ManagerApp";
import "../../src/ui/manager/manager.css";

const view = {
  width: 520,
  height: 600,
  headerHeight: 52,
  navigationHeight: 42,
  defaultRoute: "groups",
  routes: ["groups", "rules", "activity", "settings"] as const
} satisfies ManagerViewMetadata;

function transport() {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  return vi.fn(async (message: ManagerMessage): Promise<ManagerResponse> => {
    if (message.kind === "snapshots-query") {
      return {
        ok: true,
        configuration,
        view,
        viewFixture: { persistentTabsByGroup: {}, snapshots: [] }
      };
    }
    if (message.kind === "diagnostics-query") {
      return {
        ok: true,
        configuration,
        view,
        viewFixture: {
          persistentTabsByGroup: {},
          diagnostics: {
            storage: {
              syncBytes: 0,
              syncQuotaBytes: 102400,
              syncLargestItemBytes: 0,
              syncQuotaBytesPerItem: 8192,
              syncItemCount: 0,
              syncMaxItems: 512,
              localBytes: 0,
              localSoftBudgetBytes: 9437184,
              localQuotaBytes: 10485760,
              sessionBytes: 0,
              sessionQuotaBytes: 10485760
            },
            warnings: []
          }
        }
      };
    }
    return { ok: true, configuration, view };
  });
}

it("opens snapshots and diagnostics from settings and returns", async () => {
  const user = userEvent.setup();
  render(<ManagerApp transport={{ request: transport() }} initialRoute="settings" />);
  await screen.findByRole("heading", { name: "Settings" });
  await user.click(screen.getByRole("button", { name: "Snapshots" }));
  expect(await screen.findByRole("heading", { name: "Snapshots" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  await user.click(screen.getByRole("button", { name: "Back to Settings" }));
  await screen.findByRole("heading", { name: "Settings" });
  await user.click(screen.getByRole("button", { name: "Diagnostics" }));
  expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Back to Settings" }));
  expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
});

it("honors settings hash subpanels", async () => {
  window.location.hash = "#settings/snapshots";
  render(<ManagerApp transport={{ request: transport() }} />);
  expect(await screen.findByRole("heading", { name: "Snapshots" })).toBeTruthy();
  window.location.hash = "";
});

it("falls back to groups for invalid standalone hash routes", async () => {
  window.location.hash = "#snapshots";
  render(<ManagerApp transport={{ request: transport() }} />);
  expect(await screen.findByRole("heading", { name: "Groups" })).toBeTruthy();
  window.location.hash = "";
});

it("opens settings subpanels from workbench deep links", async () => {
  render(
    <ManagerApp
      transport={{ request: transport() }}
      initialRoute="settings"
      initialDeepLink="diagnostics"
    />
  );
  expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();
});
