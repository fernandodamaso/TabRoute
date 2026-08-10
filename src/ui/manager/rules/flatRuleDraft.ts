import type { ConditionNode, DuplicatePolicy, Rule, RuleAction, UUID } from "../../../domain/types";

export type ConditionLeaf = Exclude<ConditionNode, { kind: "all" | "any" }>;
export interface FlatRuleDraft {
  id?: UUID;
  targetGroupId: UUID;
  priority: number;
  required: ConditionLeaf[];
  exceptions: ConditionLeaf[];
  actions: RuleAction[];
  duplicatePolicy?: DuplicatePolicy;
  enabled: boolean;
  pausedUntil?: number | "restart";
  createdAt?: number;
  updatedAt?: number;
}
export type FlatRuleResult = { kind: "representable"; draft: FlatRuleDraft } | { kind: "unrepresentable"; rule: Rule; reason: string };

function isLeaf(node: ConditionNode): node is ConditionLeaf { return node.kind !== "all" && node.kind !== "any"; }

export function fromRule(rule: Rule): FlatRuleResult {
  const required = rule.positive.kind === "all" ? rule.positive.children : [rule.positive];
  if (rule.positive.kind === "any" || required.length === 0 || required.some((node) => !isLeaf(node)))
    return { kind: "unrepresentable", rule, reason: "Nested or OR conditions cannot be represented by the flat editor." };
  if (rule.negative.some((node) => !isLeaf(node)))
    return { kind: "unrepresentable", rule, reason: "Nested negative conditions cannot be represented by the flat editor." };
  return { kind: "representable", draft: { id: rule.id, targetGroupId: rule.targetGroupId, priority: rule.priority, required: required as ConditionLeaf[], exceptions: rule.negative as ConditionLeaf[], actions: rule.actions, duplicatePolicy: rule.duplicatePolicy, enabled: rule.enabled, pausedUntil: rule.pausedUntil, createdAt: rule.createdAt, updatedAt: rule.updatedAt } };
}

export function toRule(draft: FlatRuleDraft) {
  if (draft.required.length === 0) throw new Error("at least one positive condition is required");
  const rule = {
    schemaVersion: 1 as const,
    targetGroupId: draft.targetGroupId,
    priority: draft.priority,
    positive: draft.required.length === 1 ? draft.required[0]! : { kind: "all" as const, children: draft.required },
    negative: draft.exceptions,
    actions: draft.actions,
    ...(draft.duplicatePolicy === undefined ? {} : { duplicatePolicy: draft.duplicatePolicy }),
    enabled: draft.enabled,
    ...(draft.pausedUntil === undefined ? {} : { pausedUntil: draft.pausedUntil })
  };
  return {
    ...rule,
    ...(draft.id === undefined ? {} : { id: draft.id }),
    ...(draft.createdAt === undefined ? {} : { createdAt: draft.createdAt }),
    ...(draft.updatedAt === undefined ? {} : { updatedAt: draft.updatedAt })
  };
}

export function defaultLeaf(kind: ConditionLeaf["kind"] = "host"): ConditionLeaf {
  switch (kind) {
    case "url": return { kind, operator: "exact", value: "https://example.com/" };
    case "host": return { kind, operator: "exact", value: "example.com" };
    case "path": return { kind, operator: "exact", value: "/" };
    case "title": return { kind, operator: "contains", value: "Guide" };
    case "pinned": return { kind, value: false };
    case "openerUrl": return { kind, operator: "exact", value: "https://example.com/" };
    case "openerHost": return { kind, operator: "exact", value: "example.com" };
    case "currentGroup": return { kind, placement: { kind: "ungrouped" } };
  }
}
