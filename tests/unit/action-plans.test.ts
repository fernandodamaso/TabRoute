import { describe, expect, it } from "vitest";
import { createUuid } from "../../src/domain/ids";
import {
  buildActionPlan,
  isDestructiveAction,
  validateActionPlan
} from "../../src/actions/buildActionPlan";
import type { PlannedAction } from "../../src/actions/types";
import type { ActionId } from "../../src/domain/types";

function action(
  kind: PlannedAction["kind"],
  overrides: Partial<PlannedAction> = {}
): PlannedAction {
  const id = createUuid() as unknown as ActionId;
  const base = { id, dependsOn: [] as ActionId[] };
  switch (kind) {
    case "createTab":
      return {
        ...base,
        kind: "createTab",
        input: { url: "https://example.com/", windowId: 1, active: false },
        ...overrides
      } as PlannedAction;
    case "closeDuplicate":
      return {
        ...base,
        kind: "closeDuplicate",
        duplicate: { kind: "live", tabId: 2 },
        survivor: { kind: "live", tabId: 1 },
        ...overrides
      } as PlannedAction;
    case "ungroupTabs":
      return {
        ...base,
        kind: "ungroupTabs",
        tabs: [{ kind: "live", tabId: 1 }],
        ...overrides
      } as PlannedAction;
    case "assignTabsToManagedGroup":
      return {
        ...base,
        kind: "assignTabsToManagedGroup",
        tabs: [{ kind: "live", tabId: 1 }],
        managedGroupId:
          "00000000-0000-4000-8000-000000000001" as import("../../src/domain/types").UUID,
        windowId: 1,
        title: "Work",
        color: "blue",
        ...overrides
      } as PlannedAction;
    default:
      throw new Error(`unsupported kind ${kind}`);
  }
}

describe("action plans", () => {
  it("marks closeDuplicate and ungroupTabs as destructive", () => {
    expect(isDestructiveAction(action("closeDuplicate"))).toBe(true);
    expect(isDestructiveAction(action("ungroupTabs"))).toBe(true);
    expect(isDestructiveAction(action("createTab"))).toBe(false);
  });

  it("rejects an attempt to create an empty native group", () => {
    const plan = {
      id: createUuid() as unknown as ActionId,
      source: "reconcile" as const,
      checkpoint: "none" as const,
      actions: [
        {
          id: createUuid() as unknown as ActionId,
          dependsOn: [],
          kind: "assignTabsToManagedGroup" as const,
          tabs: [] as unknown as [{ kind: "live"; tabId: number }],
          managedGroupId:
            "00000000-0000-4000-8000-000000000001" as import("../../src/domain/types").UUID,
          windowId: 1,
          title: "Work",
          color: "blue" as const
        }
      ]
    };
    expect(validateActionPlan(plan).ok).toBe(false);
  });

  it("requires checkpoint for destructive plans", () => {
    const plan = buildActionPlan("reconcile", [action("closeDuplicate")]);
    expect(plan.checkpoint).toBe("required");
  });
});
