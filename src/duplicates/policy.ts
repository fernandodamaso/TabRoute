import type {
  ChromeAssociation,
  ChromeInventory,
  Configuration,
  DuplicatePolicy,
  DuplicateSettings,
  ManagedGroup,
  Rule,
  TabSnapshot,
  UUID
} from "../domain/types";
import { selectRule } from "../rules/ruleEngine";
import { matchesExclusion } from "./normalizeUrl";
export function resolveDuplicatePolicy(
  rule: Rule | null,
  group: ManagedGroup | null,
  global: DuplicateSettings,
  destinationManaged: boolean,
  url?: string
): DuplicatePolicy {
  if (url && matchesExclusion(url, global.globalExclusions)) {
    return { kind: "allow" };
  }
  const rulePolicy = rule?.actions.find(
    (action) => action.kind === "setDuplicatePolicy"
  )?.policy;
  if (rulePolicy) return rulePolicy;
  if (rule?.duplicatePolicy) return rule.duplicatePolicy;
  if (destinationManaged && group?.duplicatePolicy)
    return group.duplicatePolicy;
  return global.globalPolicy;
}

export function effectiveDuplicatePolicyForTab(input: {
  tab: TabSnapshot;
  inventory: ChromeInventory;
  configuration: Configuration;
  associations: readonly ChromeAssociation[];
  destinationManagedGroupId?: UUID;
  at?: number;
}): DuplicatePolicy {
  const selected = selectRule({
    configuration: input.configuration,
    tab: input.tab,
    inventory: input.inventory,
    associations: input.associations,
    at: input.at
  });
  const managedGroup = input.destinationManagedGroupId
    ? (input.configuration.groups.find(
        (group) => group.id === input.destinationManagedGroupId
      ) ?? null)
    : null;
  return resolveDuplicatePolicy(
    selected?.rule ?? null,
    managedGroup,
    input.configuration.duplicateSettings,
    managedGroup !== null,
    input.tab.routing.kind === "routable" ? input.tab.routing.url : undefined
  );
}
