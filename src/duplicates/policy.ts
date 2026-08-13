import type { DuplicatePolicy, DuplicateSettings, ManagedGroup, Rule } from "../domain/types";

export function resolveDuplicatePolicy(
  rule: Rule | null,
  group: ManagedGroup | null,
  global: DuplicateSettings,
  destinationManaged: boolean,
  url?: string
): DuplicatePolicy {
  if (url && global.globalExclusions.some((pattern) => url.includes(pattern))) {
    return { kind: "allow" };
  }
  const rulePolicy = rule?.actions.find(
    (action) => action.kind === "setDuplicatePolicy"
  )?.policy;
  if (rulePolicy) return rulePolicy;
  if (rule?.duplicatePolicy) return rule.duplicatePolicy;
  if (destinationManaged && group?.duplicatePolicy) return group.duplicatePolicy;
  return global.globalPolicy;
}
