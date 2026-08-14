import { createUuid } from "../domain/ids";
import type { ActionId } from "../domain/types";
import type { ActionPlan, ActionPlanSource, PlannedAction } from "./types";

export function isDestructiveAction(action: PlannedAction): boolean {
  return action.kind === "closeDuplicate" || action.kind === "ungroupTabs";
}

export function validateActionPlan(
  plan: ActionPlan
): { ok: true } | { ok: false; code: string; message: string } {
  const ids = new Set<ActionId>();
  for (const action of plan.actions) {
    if (ids.has(action.id)) {
      return {
        ok: false,
        code: "DUPLICATE_ACTION_ID",
        message: "duplicate action id"
      };
    }
    ids.add(action.id);
  }
  for (const action of plan.actions) {
    for (const dependency of action.dependsOn) {
      if (
        !ids.has(dependency) &&
        !plan.actions.some((candidate) => candidate.id === dependency)
      ) {
        return {
          ok: false,
          code: "MISSING_DEPENDENCY",
          message: `missing dependency ${dependency}`
        };
      }
    }
  }
  const visiting = new Set<ActionId>();
  const visited = new Set<ActionId>();
  function visit(actionId: ActionId): boolean {
    if (visited.has(actionId)) return true;
    if (visiting.has(actionId)) return false;
    visiting.add(actionId);
    const action = plan.actions.find((candidate) => candidate.id === actionId);
    if (!action) return true;
    for (const dependency of action.dependsOn) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(actionId);
    visited.add(actionId);
    return true;
  }
  for (const action of plan.actions) {
    if (!visit(action.id)) {
      return {
        ok: false,
        code: "CYCLIC_DEPENDENCY",
        message: "cyclic dependsOn"
      };
    }
  }
  for (const action of plan.actions) {
    for (const ref of tabRefs(action)) {
      if (ref.kind !== "actionOutput") continue;
      const producer = plan.actions.find(
        (candidate) => candidate.id === ref.actionId
      );
      if (
        !producer ||
        (producer.kind !== "createTab" && producer.kind !== "restoreClosedTab")
      ) {
        return {
          ok: false,
          code: "INVALID_ACTION_OUTPUT",
          message: "actionOutput producer must be createTab or restoreClosedTab"
        };
      }
    }
    if (
      action.kind === "assignTabsToManagedGroup" &&
      action.tabs.length === 0
    ) {
      return {
        ok: false,
        code: "EMPTY_GROUP",
        message: "rejects an attempt to create an empty native group"
      };
    }
  }
  return { ok: true };
}

function tabRefs(
  action: PlannedAction
): Array<
  { kind: "live"; tabId: number } | { kind: "actionOutput"; actionId: ActionId }
> {
  switch (action.kind) {
    case "moveTabs":
    case "ungroupTabs":
    case "reorderTabs":
      return [...action.tabs];
    case "assignTabsToManagedGroup":
    case "assignTabsToUnmanagedGroup":
      return [...action.tabs];
    case "focusTab":
      return [action.tab];
    case "closeDuplicate":
      return [action.duplicate, action.survivor];
    default:
      return [];
  }
}

export function buildActionPlan(
  source: ActionPlanSource,
  actions: PlannedAction[],
  options?: { requireCheckpoint?: boolean }
): ActionPlan {
  const id = createUuid() as unknown as ActionId;
  const destructive = actions.some(isDestructiveAction);
  const checkpoint =
    destructive || options?.requireCheckpoint || source === "snapshot"
      ? "required"
      : "none";
  const plan: ActionPlan = { id, source, actions, checkpoint };
  const validation = validateActionPlan(plan);
  if (!validation.ok) throw new Error(validation.message);
  return plan;
}
