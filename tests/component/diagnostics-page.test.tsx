// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { DiagnosticsViewState } from "../../src/settings/diagnosticsState";
import { DiagnosticsPage } from "../../src/ui/manager/pages/DiagnosticsPage";
import "../../src/ui/manager/manager.css";

const diagnostics: DiagnosticsViewState = {
  storage: {
    syncBytes: 1200,
    syncQuotaBytes: 102400,
    syncLargestItemBytes: 400,
    syncQuotaBytesPerItem: 8192,
    syncItemCount: 2,
    syncMaxItems: 512,
    localBytes: 5000,
    localSoftBudgetBytes: 9437184,
    localQuotaBytes: 10485760,
    sessionBytes: 200,
    sessionQuotaBytes: 10485760
  },
  warnings: ["SYNC_INCOMPLETE"]
};

it("renders storage diagnostics and warnings", () => {
  render(
    <DiagnosticsPage
      diagnostics={diagnostics}
      command={async () => undefined}
      onBack={() => undefined}
    />
  );
  expect(screen.getByRole("heading", { name: "Diagnostics" })).toBeTruthy();
  expect(screen.getByText(/Sync: 1200\/102400 bytes/)).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("SYNC_INCOMPLETE");
});

it("dispatches diagnostics commands", async () => {
  const user = userEvent.setup();
  const command = vi.fn(async () => undefined);
  const writeText = vi.fn(async () => undefined);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
  render(
    <DiagnosticsPage
      diagnostics={{ ...diagnostics, warnings: ["SYNC_INCOMPLETE", "LOCAL_BUDGET"] }}
      command={command}
      onBack={() => undefined}
    />
  );
  await user.click(screen.getByRole("button", { name: "Recheck" }));
  await user.click(screen.getByRole("button", { name: "Retry sync" }));
  await user.click(screen.getByRole("button", { name: "Reconcile all tabs" }));
  await user.click(screen.getByRole("button", { name: "Copy report" }));
  await user.click(screen.getByRole("button", { name: "Export activity log" }));
  expect(command).toHaveBeenCalledWith({ kind: "diagnosticsRecheck" });
  expect(command).toHaveBeenCalledWith({ kind: "retryPendingSync" });
  expect(command).toHaveBeenCalledWith({ kind: "reconcileAll" });
  expect(command).toHaveBeenCalledWith({ kind: "exportActivityLog" });
});

it("hides retry when sync is only invalid", () => {
  render(
    <DiagnosticsPage
      diagnostics={{ ...diagnostics, warnings: ["SYNC_INVALID"] }}
      command={async () => undefined}
      onBack={() => undefined}
    />
  );
  expect(screen.queryByRole("button", { name: "Retry sync" })).toBeNull();
  expect(screen.getByRole("button", { name: "Recheck" })).toBeTruthy();
});
