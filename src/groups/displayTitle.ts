import type {
  ChromeGroupColor,
  Configuration,
  ManagedGroup,
  UUID
} from "../domain/types";
import { updateManagedGroup } from "../domain/defaults";

export function renderGroupTitle(group: Pick<ManagedGroup, "name" | "emoji">) {
  return group.emoji ? `${group.emoji} ${group.name}` : group.name;
}

export function applyChromeGroupPresentation(
  configuration: Configuration,
  managedGroupId: UUID,
  title: string,
  color: ChromeGroupColor
): Configuration {
  const group = configuration.groups.find(
    (candidate) => candidate.id === managedGroupId
  );
  if (!group) return configuration;
  const configuredPrefix = group.emoji ? `${group.emoji} ` : "";
  const name =
    configuredPrefix && title.startsWith(configuredPrefix)
      ? title.slice(configuredPrefix.length)
      : title;
  const nextName = name || group.name;
  if (nextName === group.name && color === group.color) return configuration;
  return updateManagedGroup(configuration, managedGroupId, {
    name: nextName,
    color
  });
}
