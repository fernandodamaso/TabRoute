import { useEffect, useState } from "react";
import type {
  Configuration,
  ConditionNode,
  Rule,
  UUID
} from "../../../domain/types";
import { renderGroupTitle } from "../../../groups/displayTitle";
import type { ManagerCommand, ManagerResponse } from "../types";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { RuleActionsMenu } from "./RuleActionsMenu";

type RuleFilter = "All" | "Active" | "Paused" | "Off";
function isPaused(value: Rule["pausedUntil"]) {
  return (
    value === "restart" || (typeof value === "number" && value > Date.now())
  );
}
export function ruleStatus(rule: Rule): Exclude<RuleFilter, "All"> {
  return !rule.enabled
    ? "Off"
    : isPaused(rule.pausedUntil)
      ? "Paused"
      : "Active";
}
function summary(node: ConditionNode): string {
  if (node.kind === "all" || node.kind === "any")
    return node.children
      .map(summary)
      .join(node.kind === "all" ? " AND " : " OR ");
  if (node.kind === "pinned") return node.value ? "Pinned" : "Not pinned";
  if (node.kind === "currentGroup") return `Current ${node.placement.kind}`;
  return "value" in node ? node.value : node.kind;
}

type DeletingRule = { rule: Rule; trigger?: HTMLButtonElement };

export function RulesOverview({
  configuration,
  command,
  initialConfirmDeleteRuleId,
  onInitialConfirmDeleteConsumed,
  onEdit,
  onCreate
}: {
  configuration: Configuration;
  command: (message: ManagerCommand) => Promise<ManagerResponse>;
  initialConfirmDeleteRuleId?: UUID;
  onInitialConfirmDeleteConsumed?: () => void;
  onEdit?: (ruleId: UUID) => void;
  onCreate?: () => void;
}) {
  const [filter, setFilter] = useState<RuleFilter>("All");
  const [deleting, setDeleting] = useState<DeletingRule>();
  useEffect(() => {
    if (!initialConfirmDeleteRuleId) return;
    const rule = configuration.rules.find(
      (candidate) => candidate.id === initialConfirmDeleteRuleId
    );
    if (!rule) return;
    setDeleting({ rule });
    onInitialConfirmDeleteConsumed?.();
  }, [
    configuration.rules,
    initialConfirmDeleteRuleId,
    onInitialConfirmDeleteConsumed
  ]);
  const filtered = configuration.rules.filter(
    (rule) => filter === "All" || ruleStatus(rule) === filter
  );
  const run = (message: ManagerCommand) => {
    void command(message);
  };
  return (
    <div className="rules-overview">
      <div className="rules-overview-heading">
        <div>
          <p className="manager-eyebrow">AUTOMATION</p>
          <h1>Rules</h1>
        </div>
        <button type="button" className="primary-button" onClick={onCreate}>
          Add rule
        </button>
      </div>
      <div className="rules-filters" role="group" aria-label="Rule filters">
        {(["All", "Active", "Paused", "Off"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <p className="rules-count">
        {filtered.length} {filtered.length === 1 ? "rule" : "rules"}
      </p>
      <div className="rules-list">
        {filtered.map((rule) => {
          const target = configuration.groups.find(
            (group) => group.id === rule.targetGroupId
          );
          const status = ruleStatus(rule);
          return (
            <article
              key={rule.id}
              className="rule-row"
              aria-label={`Rule ${rule.id.slice(0, 8)}`}
            >
              <div className="rule-row-main">
                <div>
                  <strong>{summary(rule.positive)}</strong>
                  <p>
                    <span>Priority {rule.priority}</span>
                    <span> · </span>
                    <span>
                      {target ? renderGroupTitle(target) : "Missing group"}
                    </span>
                  </p>
                </div>
                <span
                  className={`rule-status rule-status-${status.toLowerCase()}`}
                >
                  {status}
                </span>
              </div>
              <div className="rule-row-actions">
                <label className="rule-enabled">
                  <input
                    type="checkbox"
                    aria-label={`Enabled ${rule.id.slice(0, 8)}`}
                    checked={rule.enabled}
                    onChange={(event) =>
                      run({
                        kind: "manager-command",
                        command: {
                          kind: "setRuleEnabled",
                          ruleId: rule.id,
                          enabled: event.target.checked
                        }
                      })
                    }
                  />{" "}
                  Enabled
                </label>
                <button
                  type="button"
                  onClick={() =>
                    run({
                      kind: "manager-command",
                      command: {
                        kind: "setRulePaused",
                        ruleId: rule.id,
                        pausedUntil: isPaused(rule.pausedUntil)
                          ? undefined
                          : "restart"
                      }
                    })
                  }
                >
                  {isPaused(rule.pausedUntil) ? "Resume rule" : "Pause rule"}
                </button>
                <button type="button" onClick={() => onEdit?.(rule.id)}>
                  Edit
                </button>
                <RuleActionsMenu
                  rule={rule}
                  onEdit={() => onEdit?.(rule.id)}
                  onDuplicate={() =>
                    run({
                      kind: "manager-command",
                      command: { kind: "duplicateRule", ruleId: rule.id }
                    })
                  }
                  onDelete={(trigger) => setDeleting({ rule, trigger })}
                />
              </div>
            </article>
          );
        })}
      </div>
      {deleting && (
        <ConfirmationDialog
          title="Delete rule?"
          message="This removes the rule from the active configuration."
          onCancel={() => {
            const trigger = deleting.trigger;
            setDeleting(undefined);
            if (trigger) queueMicrotask(() => trigger.focus());
          }}
          onConfirm={() => {
            const trigger = deleting.trigger;
            run({
              kind: "manager-command",
              command: { kind: "deleteRule", ruleId: deleting.rule.id }
            });
            setDeleting(undefined);
            if (trigger) queueMicrotask(() => trigger.focus());
          }}
        />
      )}
    </div>
  );
}
