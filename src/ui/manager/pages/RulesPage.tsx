import type { Configuration, UUID } from "../../../domain/types";
import type { ManagerCommand, ManagerResponse } from "../types";
import { RulesOverview } from "../rules/RulesOverview";
import { RuleEditorPage } from "./RuleEditorPage";

export function RulesPage({
  configuration,
  command,
  editingRuleId,
  initialConfirmDeleteRuleId,
  onInitialConfirmDeleteConsumed,
  onEdit,
  onCreate,
  onCancel,
  onSaved,
  prefill
}: {
  configuration: Configuration;
  command: (message: ManagerCommand) => Promise<ManagerResponse>;
  editingRuleId?: UUID | "new";
  initialConfirmDeleteRuleId?: UUID;
  onInitialConfirmDeleteConsumed?: () => void;
  onEdit?: (ruleId: UUID) => void;
  onCreate?: () => void;
  onCancel: () => void;
  onSaved?: (configuration: Configuration) => void;
  prefill?: { host: string; url: string };
}) {
  const rule = editingRuleId && editingRuleId !== "new"
    ? configuration.rules.find((candidate) => candidate.id === editingRuleId)
    : undefined;
  if (editingRuleId)
    return <div className="rules-page">
      <RuleEditorPage
        configuration={configuration}
        rule={rule}
        command={command}
        onCancel={onCancel}
        onSaved={onSaved}
        prefill={editingRuleId === "new" ? prefill : undefined}
      />
    </div>;
  return <div className="rules-page">
    <RulesOverview
      configuration={configuration}
      command={command}
      initialConfirmDeleteRuleId={initialConfirmDeleteRuleId}
      onInitialConfirmDeleteConsumed={onInitialConfirmDeleteConsumed}
      onEdit={onEdit}
      onCreate={onCreate}
    />
  </div>;
}
