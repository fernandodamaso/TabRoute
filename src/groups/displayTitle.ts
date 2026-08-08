import type { ManagedGroup } from "../domain/types";

export function renderGroupTitle(group: Pick<ManagedGroup, "name" | "emoji">) {
  return group.emoji ? `${group.emoji} ${group.name}` : group.name;
}
