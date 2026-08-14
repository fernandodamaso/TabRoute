// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActivityPage } from "../../src/ui/manager/pages/ActivityPage";
import { createUuid } from "../../src/domain/ids";

describe("ActivityPage", () => {
  it("filters, groups, undoes, and confirms clear history", async () => {
    const undoId = createUuid();
    const command = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <ActivityPage
        activity={[
          {
            schemaVersion: 1,
            id: createUuid(),
            action: "Closed duplicate",
            result: "success",
            affectedManagedGroupIds: [],
            affectedUrls: ["https://example.com/"],
            undoId,
            createdAt: Date.now()
          },
          {
            schemaVersion: 1,
            id: createUuid(),
            action: "Routed tab",
            result: "failure",
            affectedManagedGroupIds: [],
            affectedUrls: [],
            createdAt: Date.now() - 86_400_000
          }
        ]}
        availableUndo={{
          schemaVersion: 1,
          id: undoId,
          actionId: createUuid() as never,
          browserSessionId: "session" as never,
          payloads: [],
          expiresAt: Date.now() + 30_000,
          createdAt: Date.now()
        }}
        command={command}
      />
    );

    await user.selectOptions(
      screen.getByLabelText("Filter by status"),
      "success"
    );
    expect(screen.getByText("Closed duplicate")).toBeTruthy();
    expect(screen.queryByText("Routed tab")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(command).toHaveBeenCalledWith({ kind: "undo", undoId });

    await user.click(screen.getByRole("button", { name: "Clear history" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(command).not.toHaveBeenCalledWith({ kind: "clearActivity" });

    await user.click(screen.getByRole("button", { name: "Clear history" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(command).toHaveBeenCalledWith({ kind: "clearActivity" });
  });
});
