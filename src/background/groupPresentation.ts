import { buildActionPlan } from "../actions/buildActionPlan";
import {
  executeActionPlan,
  type ActionEngineDeps
} from "../actions/executeActionPlan";
import type { PlannedAction } from "../actions/types";
import { reconstructAssociations } from "../chrome/reconstructAssociations";
import { createUuid } from "../domain/ids";
import type {
  ActionId,
  Configuration,
  RuntimeSession,
  UUID
} from "../domain/types";
import { renderGroupTitle } from "../groups/displayTitle";

export function isGuardedGroupPresentationEcho(
  session: RuntimeSession,
  chromeGroupId: number
): boolean {
  return session.operationGuards.some(
    (guard) =>
      guard.chromeGroupIds.includes(chromeGroupId) &&
      (guard.operation === "assignTabsToManagedGroup" ||
        guard.operation === "updateManagedGroup" ||
        guard.operation === "moveManagedGroup")
  );
}

export async function applyManagedGroupPresentationEdit(input: {
  groupId: UUID;
  previousConfiguration: Configuration;
  nextConfiguration: Configuration;
  actionDeps: ActionEngineDeps;
}): Promise<void> {
  const nextGroup = input.nextConfiguration.groups.find(
    (group) => group.id === input.groupId
  );
  if (!nextGroup) return;

  const inventory = await input.actionDeps.reads.readInventory();
  const associations = reconstructAssociations(
    inventory,
    input.previousConfiguration
  ).filter((association) => association.managedGroupId === input.groupId);
  if (associations.length === 0) return;

  const actions: PlannedAction[] = associations.map((association) => ({
    id: createUuid() as unknown as ActionId,
    dependsOn: [],
    kind: "updateManagedGroup",
    managedGroupId: input.groupId,
    windowId: association.chromeWindowId,
    patch: {
      title: renderGroupTitle(nextGroup),
      color: nextGroup.color
    }
  }));
  const result = await executeActionPlan(buildActionPlan("user", actions), {
    ...input.actionDeps,
    configuration: input.previousConfiguration
  });
  if (result.status !== "success") {
    throw new Error(result.errorCode ?? "GROUP_PRESENTATION_UPDATE_FAILED");
  }
}
