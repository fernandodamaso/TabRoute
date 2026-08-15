import type { ManagedGroup, UUID } from "../../../domain/types";
import type { ConditionLeaf } from "./flatRuleDraft";
import { defaultLeaf } from "./flatRuleDraft";

const fields: Array<{ value: ConditionLeaf["kind"]; label: string }> = [
  { value: "url", label: "URL" },
  { value: "host", label: "Host" },
  { value: "path", label: "Path" },
  { value: "title", label: "Title" },
  { value: "pinned", label: "Pinned" },
  { value: "openerUrl", label: "Opener URL" },
  { value: "openerHost", label: "Opener host" },
  { value: "currentGroup", label: "Current group" }
];
function operators(kind: ConditionLeaf["kind"]) {
  if (kind === "url") return ["exact", "pattern", "regex"] as const;
  if (kind === "host") return ["exact", "suffix"] as const;
  if (kind === "path") return ["exact", "prefix"] as const;
  if (kind === "title") return ["contains", "exact", "regex"] as const;
  if (kind === "openerUrl" || kind === "openerHost")
    return ["exact", "pattern", "suffix"] as const;
  return [] as const;
}

export function ConditionRow({
  condition,
  index,
  groups,
  onChange,
  onRemove,
  removeLabel,
  removeDisabled = false,
  valueRef
}: {
  condition: ConditionLeaf;
  index: number;
  groups: ManagedGroup[];
  onChange: (condition: ConditionLeaf) => void;
  onRemove?: () => void;
  removeLabel?: string;
  removeDisabled?: boolean;
  valueRef?: (element: HTMLInputElement | HTMLSelectElement | null) => void;
}) {
  const available = operators(condition.kind);
  const selectedValue =
    condition.kind === "currentGroup"
      ? condition.placement.kind === "managed"
        ? `managed:${condition.placement.managedGroupId}`
        : condition.placement.kind
      : condition.kind === "pinned"
        ? String(condition.value)
        : condition.value;
  return (
    <div className="condition-row" data-condition-row={index}>
      <label>
        Field
        <select
          aria-label={`Condition field ${index}`}
          value={condition.kind}
          onChange={(event) =>
            onChange(defaultLeaf(event.target.value as ConditionLeaf["kind"]))
          }
        >
          {fields.map((field) => (
            <option key={field.value} value={field.value}>
              {field.label}
            </option>
          ))}
        </select>
      </label>
      {available.length > 0 && "operator" in condition && (
        <label>
          Operator
          <select
            aria-label={`Condition operator ${index}`}
            value={condition.operator}
            onChange={(event) =>
              onChange({ ...condition, operator: event.target.value as never })
            }
          >
            {available.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </select>
        </label>
      )}
      {condition.kind === "pinned" ? (
        <label className="toggle-row">
          <input
            ref={(element) => valueRef?.(element)}
            aria-label={`Condition value ${index}`}
            type="checkbox"
            checked={condition.value}
            onChange={(event) =>
              onChange({ ...condition, value: event.target.checked })
            }
          />{" "}
          Pinned
        </label>
      ) : condition.kind === "currentGroup" ? (
        <label>
          Value
          <select
            aria-label={`Condition value ${index}`}
            value={selectedValue}
            ref={(element) => valueRef?.(element)}
            onChange={(event) =>
              onChange({
                ...condition,
                placement: event.target.value.startsWith("managed:")
                  ? {
                      kind: "managed",
                      managedGroupId: event.target.value.slice(8) as UUID
                    }
                  : { kind: event.target.value as "ungrouped" | "unmanaged" }
              })
            }
          >
            <option value="ungrouped">Ungrouped</option>
            <option value="unmanaged">Unmanaged</option>
            {groups.map((group) => (
              <option key={group.id} value={`managed:${group.id}`}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          Value
          <input
            ref={(element) => valueRef?.(element)}
            aria-label={`Condition value ${index}`}
            value={"value" in condition ? condition.value : ""}
            onChange={(event) =>
              onChange({
                ...condition,
                value: event.target.value
              } as ConditionLeaf)
            }
          />
        </label>
      )}
      {onRemove && removeLabel && (
        <button
          type="button"
          className="condition-remove"
          disabled={removeDisabled}
          aria-label={removeLabel}
          onClick={onRemove}
        >
          Remove
        </button>
      )}
    </div>
  );
}
