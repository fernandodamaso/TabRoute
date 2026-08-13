import { createUuid } from "../domain/ids";
import { renderGroupTitle } from "../groups/displayTitle";
import { buildActionPlan } from "../actions/buildActionPlan";
import type { ActionPlan, PlannedAction } from "../actions/types";
import type {
  ActionId,
  ChromeAssociation,
  Configuration,
  UUID
} from "../domain/types";
import type { DuplicateDecision } from "./resolveDuplicate";

export function planDuplicateClose(
  decision: DuplicateDecision,
  configuration: Configuration,
  _associations: readonly ChromeAssociation[]
): ActionPlan {
  const actions: PlannedAction[] = [];
  let lastId: ActionId | undefined;

  function push(action: PlannedAction) {
    actions.push(action);
    lastId = action.id;
  }

  function dependsOn(): ActionId[] {
    return lastId ? [lastId] : [];
  }

  if (decision.moveSurvivor) {
    if (decision.destination === "ungrouped") {
      push({
        id: createUuid() as unknown as ActionId,
        dependsOn: dependsOn(),
        kind: "ungroupTabs",
        tabs: [{ kind: "live", tabId: decision.survivor.id }]
      });
    } else if (decision.destination) {
      const group = configuration.groups.find(
        (candidate) => candidate.id === decision.destination
      );
      if (group) {
        push({
          id: createUuid() as unknown as ActionId,
          dependsOn: dependsOn(),
          kind: "assignTabsToManagedGroup",
          tabs: [{ kind: "live", tabId: decision.survivor.id }],
          managedGroupId: decision.destination as UUID,
          windowId: decision.survivor.windowId,
          title: renderGroupTitle(group),
          color: group.color
        });
      }
    }
  }

  if (decision.focusSurvivor) {
    push({
      id: createUuid() as unknown as ActionId,
      dependsOn: dependsOn(),
      kind: "focusTab",
      tab: { kind: "live", tabId: decision.survivor.id },
      windowId: decision.survivor.windowId
    });
  }

  for (const duplicate of decision.duplicatesToClose) {
    push({
      id: createUuid() as unknown as ActionId,
      dependsOn: dependsOn(),
      kind: "closeDuplicate",
      duplicate: { kind: "live", tabId: duplicate.id },
      survivor: { kind: "live", tabId: decision.survivor.id }
    });
  }

  return buildActionPlan("duplicate", actions);
}
