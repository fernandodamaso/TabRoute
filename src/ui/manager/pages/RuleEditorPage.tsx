import { useRef, useState } from "react";
import { validateConfiguration } from "../../../domain/schemas";
import type { Configuration, Rule, RuleAction, UUID, DuplicatePolicy } from "../../../domain/types";
import type { ManagerCommand, ManagerResponse } from "../types";
import { ConditionRow } from "../rules/ConditionRow";
import { defaultLeaf, fromRule, toRule, type FlatRuleDraft } from "../rules/flatRuleDraft";
import { validateRuleActions } from "../../../rules/ruleEngine";

function newDraft(configuration: Configuration): FlatRuleDraft {
  return { targetGroupId: configuration.groups[0]!.id, priority: 0, required: [defaultLeaf()], exceptions: [], actions: [{ kind: "group" }], enabled: true };
}

function placement(actions: readonly RuleAction[]) {
  return actions.find((action): action is { kind: "group" } | { kind: "ungroup" } => action.kind === "group" || action.kind === "ungroup")?.kind ?? "group";
}

function replaceAction(actions: readonly RuleAction[], kind: RuleAction["kind"], next?: RuleAction) {
  return [...actions.filter((action) => action.kind !== kind), ...(next ? [next] : [])];
}

function setPlacement(actions: readonly RuleAction[], nextPlacement: "group" | "ungroup") {
  const bounded = nextPlacement === "group" ? actions : actions.filter((action) => action.kind !== "makePersistent" && action.kind !== "setCollapsed");
  return [{ kind: nextPlacement } as RuleAction, ...bounded.filter((action) => action.kind !== "group" && action.kind !== "ungroup")];
}

function duplicatePolicyAction(actions: readonly RuleAction[]) {
  return actions.find((action): action is { kind: "setDuplicatePolicy"; policy: DuplicatePolicy } => action.kind === "setDuplicatePolicy");
}

function collapseAction(actions: readonly RuleAction[]) {
  return actions.find((action): action is { kind: "setCollapsed"; collapsed: boolean } => action.kind === "setCollapsed");
}

export function RuleEditorPage({ configuration, rule, command, onCancel, onSaved }: {
  configuration: Configuration;
  rule?: Rule;
  command: (message: ManagerCommand) => Promise<ManagerResponse>;
  onCancel: () => void;
  onSaved?: (configuration: Configuration) => void;
}) {
  const loaded = rule ? fromRule(rule) : { kind: "representable" as const, draft: newDraft(configuration) };
  const [draft, setDraft] = useState<FlatRuleDraft>(loaded.kind === "representable" ? loaded.draft : newDraft(configuration));
  const [error, setError] = useState<string>();
  const firstValueRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
  if (loaded.kind === "unrepresentable") return <div className="rule-editor"><h1>Rule editor</h1><p role="alert">{loaded.reason}</p><p>Cancel keeps the stored legacy rule unchanged.</p><button type="button" onClick={onCancel}>Cancel</button></div>;
  const currentPlacement = placement(draft.actions);
  const currentDuplicatePolicy = duplicatePolicyAction(draft.actions)?.policy;
  const currentCollapse = collapseAction(draft.actions);
  const save = async () => {
    try {
      validateRuleActions(draft.actions);
      const candidate = toRule(draft);
      const withRule = draft.id ? configuration.rules.map((item) => item.id === draft.id ? { ...item, ...candidate } : item) : [...configuration.rules, { ...candidate, id: "00000000-0000-4000-8000-000000000099" as UUID, createdAt: 1, updatedAt: 1 }];
      validateConfiguration({ ...configuration, rules: withRule });
      setError(undefined);
      const response = await command({ kind: "manager-command", command: { kind: "saveRule", rule: candidate } });
      if (!response.ok) throw new Error(response.error.message);
      onSaved?.(response.configuration);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Rule is invalid");
      firstValueRef.current?.focus();
    }
  };
  return <div className="rule-editor"><div className="rule-editor-heading"><div><p className="manager-eyebrow">RULES</p><h1>{rule ? "Edit rule" : "New rule"}</h1></div><span>IF / AND / NOT</span></div>
    <section className="manager-card"><h2>IF</h2><div className="condition-rows">{draft.required.map((condition, index) => <ConditionRow key={index} condition={condition} index={index + 1} groups={configuration.groups} valueRef={index === 0 ? (element) => { firstValueRef.current = element; } : undefined} onChange={(next) => setDraft((current) => ({ ...current, required: current.required.map((item, itemIndex) => itemIndex === index ? next : item) }))} />)}</div><button type="button" onClick={() => setDraft((current) => ({ ...current, required: [...current.required, defaultLeaf()] }))}>Add condition</button></section>
    <section className="manager-card"><h2>AND</h2><p className="manager-note">All required conditions must match.</p></section>
    <section className="manager-card"><h2>NOT</h2><div className="condition-rows">{draft.exceptions.map((condition, index) => <ConditionRow key={index} condition={condition} index={index + 1} groups={configuration.groups} onChange={(next) => setDraft((current) => ({ ...current, exceptions: current.exceptions.map((item, itemIndex) => itemIndex === index ? next : item) }))} />)}</div><button type="button" onClick={() => setDraft((current) => ({ ...current, exceptions: [...current.exceptions, { kind: "title", operator: "contains", value: "Blocked" }] }))}>Add exception</button></section>
    <section className="manager-card"><h2>THEN</h2><label>Placement<select aria-label="Placement action" value={currentPlacement} onChange={(event) => setDraft((current) => ({ ...current, actions: setPlacement(current.actions, event.target.value as "group" | "ungroup") }))}><option value="group">Group</option><option value="ungroup">Ungroup</option></select></label><label>Target group<select value={draft.targetGroupId} disabled={currentPlacement === "ungroup"} onChange={(event) => setDraft((current) => ({ ...current, targetGroupId: event.target.value as UUID }))}>{configuration.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><label>Priority<input type="number" value={draft.priority} onChange={(event) => setDraft((current) => ({ ...current, priority: Number(event.target.value) }))} /></label><label className="toggle-row"><input aria-label="Make persistent" type="checkbox" checked={draft.actions.some((action) => action.kind === "makePersistent")} disabled={currentPlacement === "ungroup"} onChange={(event) => setDraft((current) => ({ ...current, actions: replaceAction(current.actions, "makePersistent", event.target.checked ? { kind: "makePersistent" } : undefined) }))} /> Make persistent</label><label>Duplicate policy action<select aria-label="Duplicate policy action" value={currentDuplicatePolicy?.kind ?? "none"} onChange={(event) => setDraft((current) => ({ ...current, actions: replaceAction(current.actions, "setDuplicatePolicy", event.target.value === "none" ? undefined : { kind: "setDuplicatePolicy", policy: event.target.value === "pattern" ? { kind: "pattern", pattern: "" } : { kind: event.target.value as Exclude<DuplicatePolicy["kind"], "pattern"> } }) }))}><option value="none">None</option><option value="allow">Allow</option><option value="exactUrl">Exact URL</option><option value="fragmentlessUrl">Fragmentless URL</option><option value="domain">Domain</option><option value="urlAndTitle">URL and title</option><option value="pattern">Pattern</option></select></label>{currentDuplicatePolicy?.kind === "pattern" && <label>Duplicate pattern<input aria-label="Duplicate pattern" value={currentDuplicatePolicy.pattern} onChange={(event) => setDraft((current) => ({ ...current, actions: replaceAction(current.actions, "setDuplicatePolicy", { kind: "setDuplicatePolicy", policy: { kind: "pattern", pattern: event.target.value } }) }))} /></label>}<label>Collapse action<select aria-label="Collapse action" value={currentCollapse ? (currentCollapse.collapsed ? "collapsed" : "expanded") : "none"} disabled={currentPlacement === "ungroup"} onChange={(event) => setDraft((current) => ({ ...current, actions: replaceAction(current.actions, "setCollapsed", event.target.value === "none" ? undefined : { kind: "setCollapsed", collapsed: event.target.value === "collapsed" }) }))}><option value="none">No change</option><option value="expanded">Expand</option><option value="collapsed">Collapse</option></select></label><label className="toggle-row"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /> Enabled</label></section>
    {error && <p role="alert" className="editor-error">{error}</p>}<div className="editor-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary-button" onClick={() => void save()}>Save rule</button></div>
  </div>;
}
