import type { LiveChromePort } from "../chrome/types";
import { isRoutableUrl } from "../chrome/types";
import { executeActionPlan, type ActionEngineDeps } from "../actions/executeActionPlan";
import { planRuleRoute } from "../actions/planActions";
import type {
  ActionId,
  ChromeAssociation,
  ChromeInventory,
  ChromeTabSnapshot,
  Configuration,
  ManagedGroup,
  Rule,
  RuntimeSession,
  TabSnapshot,
  UUID
} from "../domain/types";
import { createUuid } from "../domain/ids";
import { placementAction, selectRule } from "../rules/ruleEngine";
import { identifyClosedSession } from "../activity/identifyClosedSession";
import { appendActivityEntry } from "../activity/activityRepository";
import { createActivityEntry, type LocalRepository } from "../state/localRepository";
import { observeInventory } from "../duplicates/observations";
import { planDuplicateClose } from "../duplicates/planDuplicateClose";
import { resolveDuplicate } from "../duplicates/resolveDuplicate";
import { planUndoRestore, deriveUndoPlacementFromTab } from "../activity/undoPlanner";

function duplicateContext(input: {
  inventory: ChromeInventory;
  tab: ChromeTabSnapshot;
  configuration: Configuration;
  associations: readonly ChromeAssociation[];
  intentionallyClosedGroupIds?: readonly UUID[];
  at: number;
}): {
  rule: Rule | null;
  destination: UUID | "ungrouped" | null;
  destinationManaged: boolean;
  destinationGroup: ManagedGroup | null;
} {
  const selected = selectRule({
    configuration: input.configuration,
    tab: input.tab,
    inventory: input.inventory,
    associations: input.associations,
    at: input.at
  });
  const planned = planRuleRoute({
    inventory: input.inventory,
    tab: input.tab,
    configuration: input.configuration,
    associations: input.associations,
    intentionallyClosedGroupIds: input.intentionallyClosedGroupIds
  });
  const rule = selected?.rule ?? null;
  let destination: UUID | "ungrouped" | null = null;
  let destinationManaged = false;
  let destinationGroup: ManagedGroup | null = null;

  if (planned.kind === "routeToGroup" || planned.kind === "routeToFallback") {
    destination = planned.managedGroupId;
    destinationManaged = true;
    destinationGroup =
      input.configuration.groups.find(
        (group) => group.id === planned.managedGroupId
      ) ?? null;
  } else if (planned.kind === "ungroup") {
    destination = "ungrouped";
  } else if (rule) {
    const placement = placementAction(rule.actions);
    if (placement === "ungroup") destination = "ungrouped";
    else {
      destination = rule.targetGroupId;
      destinationManaged = true;
      destinationGroup =
        input.configuration.groups.find(
          (group) => group.id === rule.targetGroupId
        ) ?? null;
    }
  }

  return { rule, destination, destinationManaged, destinationGroup };
}

function hasLeaveWherePlaced(
  runtime: RuntimeSession,
  tabs: readonly TabSnapshot[]
): boolean {
  return tabs.some((tab) => {
    const override = runtime.manualOverrides[String(tab.id)];
    return override?.placement.kind === "leaveWherePlaced";
  });
}

async function recordClosedDuplicate(input: {
  duplicate: TabSnapshot;
  actionId: ActionId;
  sessionId: string | null;
  local: LocalRepository;
  configuration: Configuration;
  runtime: RuntimeSession;
  inventory: ChromeInventory;
  associations: readonly ChromeAssociation[];
  now: number;
}): Promise<UUID> {
  const undoId = createUuid();
  const url =
    input.duplicate.routing.kind === "routable"
      ? input.duplicate.routing.url
      : "";
  const placement = deriveUndoPlacementFromTab(
    input.duplicate,
    input.inventory,
    input.associations
  );
  const undoRecord = planUndoRestore({
    payload: {
      kind: "restoreClosedTab",
      sessionId: input.sessionId ?? undefined,
      url,
      title: input.duplicate.title,
      placement
    },
    session: input.runtime,
    now: input.now,
    undoTtlMs: input.configuration.undoTtlMs,
    browserSessionId: input.runtime.browserSessionId,
    actionId: input.actionId
  });
  await input.local.putUndo({ ...undoRecord, id: undoId });
  await appendActivityEntry(
    input.local,
    createActivityEntry({
      action: "Closed duplicate",
      result: input.sessionId ? "success" : "degraded",
      affectedManagedGroupIds: [],
      affectedUrls: url ? [url] : [],
      undoId,
      createdAt: input.now
    })
  );
  return undoId;
}

export async function attemptDuplicateClose(input: {
  tab: ChromeTabSnapshot;
  inventory: ChromeInventory;
  runtime: RuntimeSession;
  associations: readonly ChromeAssociation[];
  configuration: Configuration;
  chrome: LiveChromePort;
  local: LocalRepository;
  actionDeps: ActionEngineDeps;
  now: () => number;
  intentionallyClosedGroupIds?: readonly UUID[];
}): Promise<{
  handled: boolean;
  triggeringTabClosed: boolean;
  inventory: ChromeInventory;
}> {
  const at = input.now();
  const { rule, destination, destinationManaged, destinationGroup } =
    duplicateContext({
      inventory: input.inventory,
      tab: input.tab,
      configuration: input.configuration,
      associations: input.associations,
      intentionallyClosedGroupIds: input.intentionallyClosedGroupIds,
      at
    });
  const observed = observeInventory(input.inventory, input.runtime);
  const triggeringTab =
    observed.inventory.tabs.find((candidate) => candidate.id === input.tab.id) ??
    ({
      ...input.tab,
      routing: isRoutableUrl(input.tab.url)
        ? { kind: "routable" as const, url: input.tab.url }
        : { kind: "pending" as const }
    } satisfies TabSnapshot);
  const decision = resolveDuplicate({
    inventory: observed.inventory,
    tabs: observed.inventory.tabs,
    triggeringTab,
    configuration: input.configuration,
    associations: input.associations,
    session: observed.session,
    rule,
    destination,
    destinationManaged,
    destinationGroup
  });
  if (!decision) {
    return {
      handled: false,
      triggeringTabClosed: false,
      inventory: input.inventory
    };
  }

  const involved = [decision.survivor, ...decision.duplicatesToClose];
  if (hasLeaveWherePlaced(observed.session, involved)) {
    return {
      handled: false,
      triggeringTabClosed: false,
      inventory: input.inventory
    };
  }

  const beforeClosed = await input.chrome.getRecentlyClosed(25);
  const plan = planDuplicateClose(
    decision,
    input.configuration,
    input.associations
  );
  const result = await executeActionPlan(plan, input.actionDeps);
  const inventory = await input.chrome.readInventory();
  const afterClosed = await input.chrome.getRecentlyClosed(25);

  for (const duplicate of decision.duplicatesToClose) {
    if (inventory.tabs.some((candidate) => candidate.id === duplicate.id)) continue;
    const url =
      duplicate.routing.kind === "routable" ? duplicate.routing.url : "";
    const sessionId =
      url && isRoutableUrl(url)
        ? identifyClosedSession(beforeClosed, afterClosed, {
            url,
            title: duplicate.title
          })
        : null;
    await recordClosedDuplicate({
      duplicate,
      actionId: plan.id,
      sessionId,
      local: input.local,
      configuration: input.configuration,
      runtime: observed.session,
      inventory: input.inventory,
      associations: input.associations,
      now: at
    });
  }

  if (result.status === "failure") {
    return {
      handled: true,
      triggeringTabClosed: false,
      inventory
    };
  }

  const triggeringTabClosed = !inventory.tabs.some(
    (candidate) => candidate.id === input.tab.id
  );
  return { handled: true, triggeringTabClosed, inventory };
}
