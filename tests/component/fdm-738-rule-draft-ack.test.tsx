// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { ManagerApp } from "../../src/ui/manager/ManagerApp";
import type {
  ManagerResponse,
  ManagerViewMetadata
} from "../../src/ui/manager/types";

const view = {
  width: 520,
  height: 600,
  headerHeight: 52,
  navigationHeight: 42,
  defaultRoute: "groups",
  routes: ["groups", "rules", "activity", "settings"] as const
} satisfies ManagerViewMetadata;

it("acknowledges a pending rule draft only after the manager receives it", async () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const request = vi.fn(async (): Promise<ManagerResponse> => ({
    ok: true,
    configuration,
    view,
    viewFixture: {
      persistentTabsByGroup: {},
      pendingRuleDraft: {
        host: "example.com",
        url: "https://example.com/",
        createdAt: 42
      }
    }
  }));
  const acknowledgePendingRuleDraft = vi.fn(async () => undefined);

  render(
    <ManagerApp
      transport={{ request, acknowledgePendingRuleDraft }}
      initialRoute="groups"
    />
  );

  expect(
    await screen.findByRole("heading", { name: "New rule" })
  ).toBeTruthy();
  expect(screen.getByDisplayValue("example.com")).toBeTruthy();
  await waitFor(() =>
    expect(acknowledgePendingRuleDraft).toHaveBeenCalledWith(42)
  );
  expect(request).toHaveBeenCalledWith({ kind: "manager-query" });
});
