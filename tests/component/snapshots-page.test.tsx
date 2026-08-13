// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createDefaultConfiguration } from "../../src/domain/defaults";
import { createUuid } from "../../src/domain/ids";
import type { Snapshot } from "../../src/domain/types";
import { SnapshotsPage } from "../../src/ui/manager/pages/SnapshotsPage";

const snapshot: Snapshot = {
  schemaVersion: 1,
  id: createUuid(),
  name: "Morning",
  kind: "named",
  scope: { kind: "browser" },
  groups: [],
  createdAt: 1,
  updatedAt: 1
};

it("renders snapshots and confirms restore", async () => {
  const user = userEvent.setup();
  const command = vi.fn(async () => undefined);
  render(
    <SnapshotsPage
      snapshots={[snapshot]}
      command={command}
      onBack={() => undefined}
    />
  );
  expect(screen.getByRole("heading", { name: "Snapshots" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Restore" }));
  expect(screen.getByRole("dialog", { name: "Restore snapshot?" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Restore snapshot?" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Restore" }));
  const dialog = screen.getByRole("dialog", { name: "Restore snapshot?" });
  await user.click(within(dialog).getByRole("button", { name: "Restore" }));
  expect(command).toHaveBeenCalledWith({
    kind: "restoreSnapshot",
    snapshotId: snapshot.id
  });
});

it("renames without a destructive dialog", async () => {
  const user = userEvent.setup();
  const command = vi.fn(async () => undefined);
  render(
    <SnapshotsPage
      snapshots={[snapshot]}
      command={command}
      onBack={() => undefined}
    />
  );
  await user.click(screen.getByRole("button", { name: "Rename" }));
  await user.clear(screen.getByRole("textbox", { name: "Rename Morning" }));
  await user.type(screen.getByRole("textbox", { name: "Rename Morning" }), "Evening");
  await user.click(screen.getByRole("button", { name: "Save name" }));
  expect(command).toHaveBeenCalledWith({
    kind: "renameSnapshot",
    snapshotId: snapshot.id,
    name: "Evening"
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("confirms update and delete actions", async () => {
  const user = userEvent.setup();
  const command = vi.fn(async () => undefined);
  render(
    <SnapshotsPage
      snapshots={[snapshot]}
      command={command}
      onBack={() => undefined}
    />
  );
  await user.click(screen.getByRole("button", { name: "Update" }));
  const updateDialog = screen.getByRole("dialog", { name: "Update snapshot?" });
  await user.click(within(updateDialog).getByRole("button", { name: "Update" }));
  expect(command).toHaveBeenCalledWith({
    kind: "updateSnapshot",
    snapshotId: snapshot.id
  });
  await user.click(screen.getByRole("button", { name: "Delete" }));
  const deleteDialog = screen.getByRole("dialog", { name: "Delete snapshot?" });
  await user.click(within(deleteDialog).getByRole("button", { name: "Delete" }));
  expect(command).toHaveBeenCalledWith({
    kind: "deleteSnapshot",
    snapshotId: snapshot.id
  });
});

it("keeps templates as never in configuration", () => {
  const configuration = createDefaultConfiguration(() => createUuid());
  expect(configuration.templates).toEqual([]);
});
