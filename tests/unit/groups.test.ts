import { expect, it } from "vitest";
import {
  createDefaultConfiguration,
  createManagedGroup,
  removeManagedGroup,
  updateManagedGroup
} from "../../src/domain/defaults";
import {
  applyChromeGroupPresentation,
  renderGroupTitle
} from "../../src/groups/displayTitle";
import type { UUID } from "../../src/domain/types";

it("creates, edits, reorders, and removes a managed group without changing its UUID", () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001",
    () => 1
  );
  const created = createManagedGroup(
    configuration,
    { name: "Work", color: "blue", emoji: "💼" },
    () => "00000000-0000-4000-8000-000000000002",
    () => 2
  );
  const edited = updateManagedGroup(
    created,
    "00000000-0000-4000-8000-000000000002" as UUID,
    { name: "Focus", color: "red", emoji: "🎯", defaultOrder: 0 },
    () => 3
  );
  const removed = removeManagedGroup(
    edited,
    "00000000-0000-4000-8000-000000000002" as UUID
  );

  expect(edited.groups.find((group) => group.name === "Focus")).toMatchObject({
    id: "00000000-0000-4000-8000-000000000002",
    color: "red",
    defaultOrder: 0
  });
  expect(
    renderGroupTitle(edited.groups.find((group) => group.name === "Focus")!)
  ).toBe("🎯 Focus");
  expect(
    removed.groups.some(
      (group) => group.id === "00000000-0000-4000-8000-000000000002"
    )
  ).toBe(false);
  expect(removed.fallbackGroupId).toBe(configuration.fallbackGroupId);
});

it("preserves the fallback role when its editable presentation changes", () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001",
    () => 1
  );
  const changed = updateManagedGroup(
    configuration,
    configuration.fallbackGroupId,
    { name: "Inbox", emoji: "📥" },
    () => 2
  );
  expect(changed.fallbackGroupId).toBe(configuration.fallbackGroupId);
  expect(changed.groups[0]?.isFallback).toBe(true);
  expect(renderGroupTitle(changed.groups[0]!)).toBe("📥 Inbox");
});

it("creates newly managed groups enabled by default", () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const created = createManagedGroup(configuration, {
    name: "Work",
    color: "blue"
  }, () => "00000000-0000-4000-8000-000000000002");
  expect(created.groups[1]?.enabled).toBe(true);
});

it("imports a Chrome rename without losing the configured emoji", () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001",
    () => 1
  );
  const withEmoji = updateManagedGroup(
    configuration,
    configuration.fallbackGroupId,
    { name: "Inbox", emoji: "📥" },
    () => 2
  );
  const renamed = applyChromeGroupPresentation(
    withEmoji,
    withEmoji.fallbackGroupId,
    "📥 Triage",
    "red"
  );
  const group = renamed.groups[0]!;
  expect(group.name).toBe("Triage");
  expect(group.emoji).toBe("📥");
  expect(group.color).toBe("red");
  const emojiRemoved = applyChromeGroupPresentation(
    withEmoji,
    withEmoji.fallbackGroupId,
    "Loose title",
    "blue"
  );
  expect(emojiRemoved.groups[0]?.name).toBe("Loose title");
  expect(renderGroupTitle(emojiRemoved.groups[0]!)).toBe("📥 Loose title");
});
