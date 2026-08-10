import type { Configuration, UUID } from "../../../domain/types";
import type { ManagerCommand, ManagerResponse } from "../types";
import { RulesOverview } from "../rules/RulesOverview";
import { RuleEditorPage } from "./RuleEditorPage";

export function RulesPage({ configuration, command, editingRuleId, onEdit, onCreate, onCancel, onSaved }: { configuration: Configuration; command: (message: ManagerCommand) => Promise<ManagerResponse>; editingRuleId?: UUID | "new"; onEdit?: (ruleId: UUID) => void; onCreate?: () => void; onCancel: () => void; onSaved?: (configuration: Configuration) => void; }) {
  const rule = editingRuleId && editingRuleId !== "new" ? configuration.rules.find((candidate) => candidate.id === editingRuleId) : undefined;
  if (editingRuleId) return <div className="rules-page"><RuleEditorPage configuration={configuration} rule={rule} command={command} onCancel={onCancel} onSaved={onSaved} /></div>;
  return <div className="rules-page"><RulesOverview configuration={configuration} command={command} onEdit={onEdit} onCreate={onCreate} /></div>;
}
