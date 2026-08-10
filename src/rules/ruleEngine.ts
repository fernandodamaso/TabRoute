import type {
  ChromeAssociation,
  ChromeInventory,
  ChromeTabSnapshot,
  Configuration,
  ConditionNode,
  CurrentPlacement,
  Rule,
  RuleAction,
  UUID
} from "../domain/types";

export interface RuleEvaluation {
  matches: boolean;
  matchingLeafCount: number;
  specificityClass: number;
  literalLength: number;
}

export interface SelectedRule {
  rule: Rule;
  evaluation: RuleEvaluation;
}

type ConditionLeaf = Exclude<ConditionNode, { kind: "all" | "any" }>;

const now = () => Date.now();

function isPaused(value: number | "restart" | undefined, at: number) {
  return value === "restart" || (typeof value === "number" && value > at);
}

function glob(value: string, pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function regex(value: string, pattern: string) {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
}

function parseUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function currentPlacement(
  tab: ChromeTabSnapshot,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): CurrentPlacement {
  if (tab.chromeGroupId < 0) return { kind: "ungrouped" };
  const group = inventory.groups.find(
    (candidate) => candidate.id === tab.chromeGroupId
  );
  const association = associations.find(
    (candidate) =>
      candidate.chromeGroupId === tab.chromeGroupId &&
      candidate.chromeWindowId === tab.windowId
  );
  if (association && !group?.shared)
    return { kind: "managed", managedGroupId: association.managedGroupId };
  return { kind: "unmanaged" };
}

function placementEquals(actual: CurrentPlacement, expected: CurrentPlacement) {
  return (
    actual.kind === expected.kind &&
    (actual.kind !== "managed" ||
      actual.managedGroupId ===
        (expected as { kind: "managed"; managedGroupId: UUID }).managedGroupId)
  );
}

function leaf(
  node: ConditionLeaf,
  tab: ChromeTabSnapshot,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): RuleEvaluation {
  const url = parseUrl(tab.url);
  const opener = parseUrl(tab.openerUrl);
  let matches = false;
  let specificityClass = 0;
  switch (node.kind) {
    case "url":
      matches =
        node.operator === "exact"
          ? tab.url === node.value
          : node.operator === "pattern"
            ? glob(tab.url ?? "", node.value)
            : regex(tab.url ?? "", node.value);
      specificityClass =
        node.operator === "exact" ? 7 : node.operator === "pattern" ? 5 : 1;
      break;
    case "host":
      matches =
        node.operator === "exact"
          ? url?.hostname.toLowerCase() === node.value.toLowerCase()
          : !!url &&
            (url.hostname.toLowerCase() === node.value.toLowerCase() ||
              url.hostname
                .toLowerCase()
                .endsWith(`.${node.value.toLowerCase()}`));
      specificityClass = node.operator === "exact" ? 6 : 5;
      break;
    case "path":
      matches =
        node.operator === "exact"
          ? url?.pathname === node.value
          : !!url && url.pathname.startsWith(node.value);
      specificityClass = 4;
      break;
    case "title":
      matches =
        node.operator === "contains"
          ? tab.title
              .toLocaleLowerCase()
              .includes(node.value.toLocaleLowerCase())
          : node.operator === "exact"
            ? tab.title === node.value
            : regex(tab.title, node.value);
      specificityClass = node.operator === "regex" ? 1 : 3;
      break;
    case "pinned":
      matches = tab.pinned === node.value;
      specificityClass = 3;
      break;
    case "openerUrl":
      matches =
        node.operator === "exact"
          ? tab.openerUrl === node.value
          : node.operator === "pattern"
            ? glob(tab.openerUrl ?? "", node.value)
            : !!opener &&
              (opener.href === node.value ||
                opener.hostname.endsWith(node.value));
      specificityClass = node.operator === "pattern" ? 1 : 3;
      break;
    case "openerHost":
      matches =
        node.operator === "exact"
          ? opener?.hostname.toLowerCase() === node.value.toLowerCase()
          : node.operator === "pattern"
            ? glob(opener?.hostname ?? "", node.value)
            : !!opener &&
              opener.hostname
                .toLowerCase()
                .endsWith(`.${node.value.toLowerCase()}`);
      specificityClass = node.operator === "pattern" ? 1 : 3;
      break;
    case "currentGroup":
      matches = placementEquals(
        currentPlacement(tab, inventory, associations),
        node.placement
      );
      specificityClass = 3;
      break;
  }
  return {
    matches,
    matchingLeafCount: matches ? 1 : 0,
    specificityClass,
    literalLength: matches
      ? node.kind === "pinned" || node.kind === "currentGroup"
        ? 0
        : node.value.length
      : 0
  };
}

export function evaluateCondition(
  node: ConditionNode,
  tab: ChromeTabSnapshot,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[]
): RuleEvaluation {
  if (
    node.kind === "url" ||
    node.kind === "host" ||
    node.kind === "path" ||
    node.kind === "title" ||
    node.kind === "pinned" ||
    node.kind === "openerUrl" ||
    node.kind === "openerHost" ||
    node.kind === "currentGroup"
  )
    return leaf(node, tab, inventory, associations);
  const group = node as { kind: "all" | "any"; children: ConditionNode[] };
  const children = group.children.map((child) =>
    evaluateCondition(child, tab, inventory, associations)
  );
  const matches =
    group.kind === "all"
      ? children.every((child) => child.matches)
      : children.some((child) => child.matches);
  const matching = children.filter((child) => child.matches);
  return {
    matches,
    matchingLeafCount:
      group.kind === "all"
        ? children.reduce((total, child) => total + child.matchingLeafCount, 0)
        : matching.reduce((total, child) => total + child.matchingLeafCount, 0),
    specificityClass: matching.reduce(
      (max, child) => Math.max(max, child.specificityClass),
      0
    ),
    literalLength: matching.reduce(
      (total, child) => total + child.literalLength,
      0
    )
  };
}

export function evaluateRule(
  rule: Rule,
  tab: ChromeTabSnapshot,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[],
  at = now()
): RuleEvaluation {
  if (!rule.enabled || isPaused(rule.pausedUntil, at))
    return {
      matches: false,
      matchingLeafCount: 0,
      specificityClass: 0,
      literalLength: 0
    };
  const positive = evaluateCondition(
    rule.positive,
    tab,
    inventory,
    associations
  );
  const negativeMatches = rule.negative.some(
    (candidate) =>
      evaluateCondition(candidate, tab, inventory, associations).matches
  );
  return { ...positive, matches: positive.matches && !negativeMatches };
}

function compareEvaluations(left: SelectedRule, right: SelectedRule) {
  if (left.rule.priority !== right.rule.priority)
    return left.rule.priority - right.rule.priority;
  if (left.evaluation.specificityClass !== right.evaluation.specificityClass)
    return left.evaluation.specificityClass - right.evaluation.specificityClass;
  if (left.evaluation.matchingLeafCount !== right.evaluation.matchingLeafCount)
    return (
      left.evaluation.matchingLeafCount - right.evaluation.matchingLeafCount
    );
  if (left.evaluation.literalLength !== right.evaluation.literalLength)
    return left.evaluation.literalLength - right.evaluation.literalLength;
  return right.rule.id.localeCompare(left.rule.id);
}

export function selectRule(input: {
  configuration: Configuration;
  tab: ChromeTabSnapshot;
  inventory: ChromeInventory;
  associations: readonly ChromeAssociation[];
  at?: number;
}): SelectedRule | undefined {
  const at = input.at ?? now();
  if (
    !input.configuration.automationEnabled ||
    isPaused(input.configuration.globalPausedUntil, at)
  )
    return undefined;
  const candidates = input.configuration.rules.flatMap((rule) => {
    const target = input.configuration.groups.find(
      (group) => group.id === rule.targetGroupId
    );
    if (!target || !target.enabled || isPaused(target.pausedUntil, at)) return [];
    const evaluation = evaluateRule(
      rule,
      input.tab,
      input.inventory,
      input.associations,
      at
    );
    return evaluation.matches ? [{ rule, evaluation }] : [];
  });
  return candidates.sort(compareEvaluations).at(-1);
}

export function placementAction(
  actions: readonly RuleAction[]
): "group" | "ungroup" {
  validateRuleActions(actions);
  return actions.find(
    (action): action is { kind: "group" } | { kind: "ungroup" } =>
      action.kind === "group" || action.kind === "ungroup"
  )!.kind;
}

export function validateRuleActions(actions: readonly RuleAction[]): {
  placement: "group" | "ungroup";
} {
  const placements = actions.filter(
    (action) => action.kind === "group" || action.kind === "ungroup"
  );
  if (placements.length !== 1)
    throw new Error("rule must contain exactly one placement action");
  if (
    placements[0]!.kind === "ungroup" &&
    actions.some(
      (action) =>
        action.kind === "makePersistent" || action.kind === "setCollapsed"
    )
  )
    throw new Error("makePersistent and setCollapsed require group placement");
  if (
    actions.filter((action) => action.kind === "setDuplicatePolicy").length > 1
  )
    throw new Error("at most one duplicate policy action is allowed");
  if (actions.filter((action) => action.kind === "setCollapsed").length > 1)
    throw new Error("at most one collapse action is allowed");
  return { placement: placements[0]!.kind };
}
