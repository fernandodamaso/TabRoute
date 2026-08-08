import { useEffect, useState } from "react";
import {
  createDefaultConfiguration,
  createManagedGroup,
  removeManagedGroup,
  updateManagedGroup
} from "../../src/domain/defaults";
import type {
  ConditionNode,
  Configuration,
  ManagedGroup,
  Rule,
  RuleAction,
  UUID
} from "../../src/domain/types";
import { renderGroupTitle } from "../../src/groups/displayTitle";
import type { UiMessage } from "../../src/ui/messages";
import { validateConfiguration } from "../../src/domain/schemas";

const fallback = createDefaultConfiguration(
  () => "00000000-0000-4000-8000-000000000001"
);

function newRule(configuration: Configuration): Rule {
  const timestamp = Date.now();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID() as UUID,
    targetGroupId:
      configuration.groups.find((group) => !group.isFallback)?.id ??
      configuration.fallbackGroupId,
    priority: 0,
    positive: {
      kind: "all",
      children: [{ kind: "host", operator: "exact", value: "example.com" }]
    },
    negative: [],
    actions: [{ kind: "group" }],
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function updateNode(
  node: ConditionNode,
  path: number[],
  update: (current: ConditionNode) => ConditionNode
): ConditionNode {
  if (path.length === 0) return update(node);
  if (node.kind !== "all" && node.kind !== "any") return node;
  const [index, ...rest] = path;
  return {
    ...node,
    children: node.children.map((child, childIndex) =>
      childIndex === index ? updateNode(child, rest, update) : child
    )
  };
}

type LeafKind =
  | "url"
  | "host"
  | "path"
  | "title"
  | "pinned"
  | "openerUrl"
  | "openerHost"
  | "currentGroup";

const leafKinds: Array<{ value: LeafKind; label: string }> = [
  { value: "url", label: "URL" },
  { value: "host", label: "Host" },
  { value: "path", label: "Path" },
  { value: "title", label: "Title" },
  { value: "pinned", label: "Pinned" },
  { value: "openerUrl", label: "Opener URL" },
  { value: "openerHost", label: "Opener host" },
  { value: "currentGroup", label: "Current placement" }
];

function defaultLeaf(kind: LeafKind): ConditionNode {
  switch (kind) {
    case "url":
      return { kind, operator: "exact", value: "https://example.com/" };
    case "host":
      return { kind, operator: "exact", value: "example.com" };
    case "path":
      return { kind, operator: "exact", value: "/" };
    case "title":
      return { kind, operator: "contains", value: "Guide" };
    case "pinned":
      return { kind, value: false };
    case "openerUrl":
      return { kind, operator: "exact", value: "https://example.com/" };
    case "openerHost":
      return { kind, operator: "exact", value: "example.com" };
    case "currentGroup":
      return { kind, placement: { kind: "ungrouped" } };
  }
}

function operatorOptions(kind: Exclude<LeafKind, "pinned" | "currentGroup">) {
  if (kind === "url")
    return [
      { value: "exact", label: "Exact URL" },
      { value: "pattern", label: "URL pattern" },
      { value: "regex", label: "Regular expression" }
    ];
  if (kind === "host" || kind === "path")
    return kind === "host"
      ? [
          { value: "exact", label: "Exact host" },
          { value: "suffix", label: "Host suffix" }
        ]
      : [
          { value: "exact", label: "Exact path" },
          { value: "prefix", label: "Path prefix" }
        ];
  if (kind === "title")
    return [
      { value: "contains", label: "Contains" },
      { value: "exact", label: "Exact title" },
      { value: "regex", label: "Regular expression" }
    ];
  return [
    { value: "exact", label: "Exact" },
    { value: "pattern", label: "Pattern" },
    { value: "suffix", label: "Suffix" }
  ];
}

function replaceRuleAction(
  rule: Rule,
  action: RuleAction | undefined,
  category: "persistent" | "duplicate" | "collapse"
) {
  const without = rule.actions.filter((candidate) =>
    category === "persistent"
      ? candidate.kind !== "makePersistent"
      : category === "duplicate"
        ? candidate.kind !== "setDuplicatePolicy"
        : candidate.kind !== "setCollapsed"
  );
  return {
    ...rule,
    actions: action ? [...without, action] : without,
    updatedAt: Date.now()
  };
}

function replacePlacement(rule: Rule, placement: "group" | "ungroup") {
  const actions = rule.actions.filter(
    (action) =>
      action.kind !== "group" &&
      action.kind !== "ungroup" &&
      !(
        placement === "ungroup" &&
        (action.kind === "makePersistent" || action.kind === "setCollapsed")
      )
  );
  return {
    ...rule,
    actions: [{ kind: placement }, ...actions] as RuleAction[],
    updatedAt: Date.now()
  };
}

function duplicateActionFromSelection(value: string): RuleAction | undefined {
  if (value === "none") return undefined;
  if (value === "pattern")
    return {
      kind: "setDuplicatePolicy",
      policy: { kind: "pattern", pattern: "example.com/*" }
    };
  return {
    kind: "setDuplicatePolicy",
    policy: {
      kind: value as
        "allow" | "exactUrl" | "fragmentlessUrl" | "domain" | "urlAndTitle"
    }
  };
}

function ConditionEditor({
  node,
  path,
  groups,
  onChange
}: {
  node: ConditionNode;
  path: number[];
  groups: ManagedGroup[];
  onChange: (
    path: number[],
    update: (current: ConditionNode) => ConditionNode
  ) => void;
}) {
  if (node.kind === "all" || node.kind === "any") {
    return (
      <fieldset className="condition-group">
        <legend>{node.kind.toUpperCase()} group</legend>
        <label>
          Expression operator{" "}
          <select
            aria-label="Expression operator"
            value={node.kind}
            onChange={(event) =>
              onChange(path, (current) =>
                current.kind === "all" || current.kind === "any"
                  ? { ...current, kind: event.target.value as "all" | "any" }
                  : current
              )
            }
          >
            <option value="all">AND</option>
            <option value="any">OR</option>
          </select>
        </label>
        {node.children.map((child, index) => (
          <ConditionEditor
            key={index}
            node={child}
            path={[...path, index]}
            groups={groups}
            onChange={onChange}
          />
        ))}
        <button
          type="button"
          onClick={() =>
            onChange(path, (current) =>
              current.kind === "all" || current.kind === "any"
                ? {
                    ...current,
                    children: [
                      ...current.children,
                      {
                        kind: "all",
                        children: [
                          {
                            kind: "host",
                            operator: "exact",
                            value: "example.com"
                          }
                        ]
                      }
                    ]
                  }
                : current
            )
          }
        >
          Add nested AND
        </button>
        <button
          type="button"
          onClick={() =>
            onChange(path, (current) =>
              current.kind === "all" || current.kind === "any"
                ? {
                    ...current,
                    children: [
                      ...current.children,
                      { kind: "host", operator: "exact", value: "example.com" }
                    ]
                  }
                : current
            )
          }
        >
          Add condition
        </button>
        <button
          type="button"
          onClick={() =>
            onChange(path, (current) =>
              current.kind === "all" || current.kind === "any"
                ? {
                    ...current,
                    children: [
                      ...current.children,
                      {
                        kind: "any",
                        children: [
                          {
                            kind: "title",
                            operator: "contains",
                            value: "Guide"
                          }
                        ]
                      }
                    ]
                  }
                : current
            )
          }
        >
          Add nested OR
        </button>
      </fieldset>
    );
  }
  const currentKind = node.kind as LeafKind;
  const operatorNode = node as Exclude<
    ConditionNode,
    { kind: "all" | "any" } | { kind: "pinned" } | { kind: "currentGroup" }
  >;
  const selectedPlacement =
    node.kind === "currentGroup"
      ? node.placement.kind === "managed"
        ? `managed:${node.placement.managedGroupId}`
        : node.placement.kind
      : "";
  return (
    <div className="condition-leaf">
      <label>
        Field{" "}
        <select
          aria-label="Condition field"
          value={node.kind}
          onChange={(event) =>
            onChange(path, () => defaultLeaf(event.target.value as LeafKind))
          }
        >
          {leafKinds.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
      </label>
      {node.kind === "currentGroup" ? (
        <label>
          Current placement{" "}
          <select
            aria-label="Current placement"
            value={selectedPlacement}
            onChange={(event) =>
              onChange(path, (current) =>
                current.kind !== "currentGroup"
                  ? current
                  : {
                      ...current,
                      placement: event.target.value.startsWith("managed:")
                        ? {
                            kind: "managed",
                            managedGroupId: event.target.value.slice(
                              "managed:".length
                            ) as UUID
                          }
                        : {
                            kind: event.target.value as
                              "unmanaged" | "ungrouped"
                          }
                    }
              )
            }
          >
            <option value="ungrouped">Ungrouped</option>
            <option value="unmanaged">Unmanaged native group</option>
            {groups.map((group) => (
              <option key={group.id} value={`managed:${group.id}`}>
                {renderGroupTitle(group)}
              </option>
            ))}
          </select>
        </label>
      ) : node.kind === "pinned" ? (
        <label>
          <span className="sr-only">Pinned value</span>
          <input
            aria-label="Pinned value"
            type="checkbox"
            checked={node.value}
            onChange={(event) =>
              onChange(path, () => ({ ...node, value: event.target.checked }))
            }
          />{" "}
          Pinned
        </label>
      ) : (
        <>
          <label>
            Operator{" "}
            <select
              aria-label="Condition operator"
              value={operatorNode.operator}
              onChange={(event) =>
                onChange(path, (current) =>
                  "operator" in current
                    ? { ...current, operator: event.target.value as never }
                    : current
                )
              }
            >
              {operatorOptions(
                currentKind as Exclude<LeafKind, "pinned" | "currentGroup">
              ).map((operator) => (
                <option key={operator.value} value={operator.value}>
                  {operator.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Operand{" "}
            <input
              aria-label="Condition operand"
              value={
                "value" in node && typeof node.value === "string"
                  ? node.value
                  : ""
              }
              onChange={(event) =>
                onChange(path, (current) =>
                  current.kind === "pinned"
                    ? current
                    : "value" in current
                      ? { ...current, value: event.target.value }
                      : current
                )
              }
            />
          </label>
        </>
      )}
    </div>
  );
}

type PauseValue = number | "restart" | undefined;

function pauseMode(value: PauseValue): "none" | "timed" | "restart" {
  if (value === "restart") return "restart";
  if (typeof value === "number" && value > Date.now()) return "timed";
  return "none";
}

function pauseMinutes(value: PauseValue): number {
  if (typeof value !== "number" || value <= Date.now()) return 30;
  return Math.max(1, Math.ceil((value - Date.now()) / 60_000));
}

function PauseEditor({
  label,
  value,
  onChange
}: {
  label: string;
  value: PauseValue;
  onChange: (value: PauseValue) => void;
}) {
  const mode = pauseMode(value);
  return (
    <div className="pause-editor">
      <label>
        {label}{" "}
        <select
          aria-label={label}
          value={mode}
          onChange={(event) => {
            if (event.target.value === "none") onChange(undefined);
            else if (event.target.value === "restart") onChange("restart");
            else onChange(Date.now() + 30 * 60_000);
          }}
        >
          <option value="none">No pause</option>
          <option value="timed">Pause for a set time</option>
          <option value="restart">Pause until Chrome restart</option>
        </select>
      </label>
      {mode === "timed" && (
        <label>
          {label} minutes{" "}
          <input
            aria-label={`${label} minutes`}
            type="number"
            min={1}
            step={1}
            value={pauseMinutes(value)}
            onChange={(event) => {
              const minutes = Number(event.target.value);
              if (Number.isInteger(minutes) && minutes >= 1) {
                onChange(Date.now() + minutes * 60_000);
              }
            }}
          />
        </label>
      )}
    </div>
  );
}

function GroupEditor({
  group,
  onChange,
  onRemove
}: {
  group: ManagedGroup;
  onChange: (patch: Partial<ManagedGroup>) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset className="card">
      <legend>{renderGroupTitle(group)}</legend>
      <label>
        Name{" "}
        <input
          value={group.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label>
        Emoji{" "}
        <input
          aria-label={`${group.name} emoji`}
          value={group.emoji ?? ""}
          onChange={(event) =>
            onChange({ emoji: event.target.value || undefined })
          }
        />
      </label>
      <label>
        Color{" "}
        <select
          value={group.color}
          onChange={(event) =>
            onChange({ color: event.target.value as ManagedGroup["color"] })
          }
        >
          {[
            "grey",
            "blue",
            "red",
            "yellow",
            "green",
            "pink",
            "purple",
            "cyan",
            "orange"
          ].map((color) => (
            <option key={color}>{color}</option>
          ))}
        </select>
      </label>
      <label>
        Default order{" "}
        <input
          type="number"
          value={group.defaultOrder}
          onChange={(event) =>
            onChange({ defaultOrder: Number(event.target.value) })
          }
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={group.defaultCollapsed}
          onChange={(event) =>
            onChange({ defaultCollapsed: event.target.checked })
          }
        />{" "}
        Start collapsed
      </label>
      <PauseEditor
        label="Group pause"
        value={group.pausedUntil}
        onChange={(pausedUntil) => onChange({ pausedUntil })}
      />
      {!group.isFallback && (
        <button type="button" className="danger" onClick={onRemove}>
          Remove group
        </button>
      )}
    </fieldset>
  );
}

export function App() {
  const [configuration, setConfiguration] = useState<Configuration>(fallback);
  const [status, setStatus] = useState("Loading configuration…");

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      setStatus("Local editor preview");
      return;
    }
    void chrome.runtime
      .sendMessage({ kind: "get-configuration" } satisfies UiMessage)
      .then((response: { configuration?: Configuration } | undefined) => {
        if (response?.configuration) setConfiguration(response.configuration);
        setStatus("Ready");
      })
      .catch(() => setStatus("Unable to load configuration"));
  }, []);

  const save = () => {
    setStatus("Saving…");
    try {
      validateConfiguration(configuration);
    } catch (error) {
      setStatus(
        `Save rejected: ${error instanceof Error ? error.message : "invalid configuration"}`
      );
      return;
    }
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      setStatus("Preview changes are local only");
      return;
    }
    void chrome.runtime
      .sendMessage({
        kind: "save-configuration",
        configuration
      } satisfies UiMessage)
      .then(() => setStatus("Saved and reconciled open tabs"))
      .catch(() =>
        setStatus("Save rejected; the last valid configuration remains active")
      );
  };

  const changeGroup = (id: UUID, patch: Partial<ManagedGroup>) =>
    setConfiguration((current) => updateManagedGroup(current, id, patch));
  const changeRule = (id: UUID, patch: Partial<Rule>) =>
    setConfiguration((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === id ? { ...rule, ...patch, updatedAt: Date.now() } : rule
      ),
      updatedAt: Date.now()
    }));
  const changeCondition = (
    id: UUID,
    path: number[],
    update: (current: ConditionNode) => ConditionNode
  ) =>
    setConfiguration((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === id
          ? {
              ...rule,
              positive: updateNode(rule.positive, path, update),
              updatedAt: Date.now()
            }
          : rule
      ),
      updatedAt: Date.now()
    }));
  const changeNegative = (
    id: UUID,
    index: number,
    path: number[],
    update: (current: ConditionNode) => ConditionNode
  ) =>
    setConfiguration((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === id
          ? {
              ...rule,
              negative: rule.negative.map((node, nodeIndex) =>
                nodeIndex === index ? updateNode(node, path, update) : node
              ),
              updatedAt: Date.now()
            }
          : rule
      ),
      updatedAt: Date.now()
    }));

  return (
    <main>
      <header>
        <p className="eyebrow">TABROUTE / SETTINGS</p>
        <h1>Managed groups and rules</h1>
        <p className="lede">
          Build readable nested rules. Changes are validated before they replace
          the active configuration.
        </p>
        <PauseEditor
          label="Global pause"
          value={configuration.globalPausedUntil}
          onChange={(globalPausedUntil) =>
            setConfiguration((current) => ({
              ...current,
              globalPausedUntil,
              updatedAt: Date.now()
            }))
          }
        />
        <p role="status">{status}</p>
      </header>
      <section aria-labelledby="groups-heading">
        <div className="section-heading">
          <h2 id="groups-heading">Managed groups</h2>
          <button
            type="button"
            onClick={() =>
              setConfiguration((current) =>
                createManagedGroup(current, {
                  name: "New group",
                  color: "blue"
                })
              )
            }
          >
            Add group
          </button>
        </div>
        <div className="grid">
          {[...configuration.groups]
            .sort((a, b) => a.defaultOrder - b.defaultOrder)
            .map((group) => (
              <GroupEditor
                key={group.id}
                group={group}
                onChange={(patch) => changeGroup(group.id, patch)}
                onRemove={() =>
                  setConfiguration((current) =>
                    removeManagedGroup(current, group.id)
                  )
                }
              />
            ))}
        </div>
      </section>
      <section aria-labelledby="rules-heading">
        <div className="section-heading">
          <h2 id="rules-heading">Rules</h2>
          <button
            type="button"
            onClick={() =>
              setConfiguration((current) => ({
                ...current,
                rules: [...current.rules, newRule(current)],
                updatedAt: Date.now()
              }))
            }
          >
            Add rule
          </button>
        </div>
        {configuration.rules.length === 0 && (
          <p className="empty">
            No rules yet. Unmatched normal tabs use{" "}
            {renderGroupTitle(
              configuration.groups.find(
                (group) => group.id === configuration.fallbackGroupId
              ) ?? fallback.groups[0]!
            ).trim()}
            .
          </p>
        )}
        {configuration.rules.map((rule) => (
          <fieldset className="card rule-card" key={rule.id}>
            <legend>Rule {rule.id.slice(0, 8)}</legend>
            <label>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(event) =>
                  changeRule(rule.id, { enabled: event.target.checked })
                }
              />{" "}
              Enabled
            </label>
            <PauseEditor
              label="Rule pause"
              value={rule.pausedUntil}
              onChange={(pausedUntil) => changeRule(rule.id, { pausedUntil })}
            />
            <button
              type="button"
              className="danger"
              onClick={() =>
                setConfiguration((current) => ({
                  ...current,
                  rules: current.rules.filter(
                    (candidate) => candidate.id !== rule.id
                  ),
                  updatedAt: Date.now()
                }))
              }
            >
              Delete rule
            </button>
            <label>
              Priority{" "}
              <input
                type="number"
                value={rule.priority}
                onChange={(event) =>
                  changeRule(rule.id, { priority: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Target{" "}
              <select
                value={rule.targetGroupId}
                onChange={(event) =>
                  changeRule(rule.id, {
                    targetGroupId: event.target.value as UUID
                  })
                }
              >
                {configuration.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {renderGroupTitle(group)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Placement{" "}
              <select
                aria-label="Placement action"
                value={
                  (
                    rule.actions.find(
                      (action) =>
                        action.kind === "group" || action.kind === "ungroup"
                    ) as RuleAction | undefined
                  )?.kind ?? "group"
                }
                onChange={(event) =>
                  setConfiguration((current) => ({
                    ...current,
                    rules: current.rules.map((candidate) =>
                      candidate.id === rule.id
                        ? replacePlacement(
                            candidate,
                            event.target.value as "group" | "ungroup"
                          )
                        : candidate
                    ),
                    updatedAt: Date.now()
                  }))
                }
              >
                <option value="group">Group</option>
                <option value="ungroup">Ungroup</option>
              </select>
            </label>
            {(() => {
              const placement = rule.actions.some(
                (action) => action.kind === "ungroup"
              )
                ? "ungroup"
                : "group";
              const duplicateAction = rule.actions.find(
                (
                  action
                ): action is Extract<
                  RuleAction,
                  { kind: "setDuplicatePolicy" }
                > => action.kind === "setDuplicatePolicy"
              );
              const collapseAction = rule.actions.find(
                (
                  action
                ): action is Extract<RuleAction, { kind: "setCollapsed" }> =>
                  action.kind === "setCollapsed"
              );
              return (
                <>
                  <label>
                    <input
                      aria-label="Make persistent"
                      type="checkbox"
                      disabled={placement === "ungroup"}
                      checked={rule.actions.some(
                        (action) => action.kind === "makePersistent"
                      )}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          rules: current.rules.map((candidate) =>
                            candidate.id === rule.id
                              ? replaceRuleAction(
                                  candidate,
                                  event.target.checked
                                    ? { kind: "makePersistent" }
                                    : undefined,
                                  "persistent"
                                )
                              : candidate
                          ),
                          updatedAt: Date.now()
                        }))
                      }
                    />{" "}
                    Make persistent
                  </label>
                  <label>
                    Duplicate policy action{" "}
                    <select
                      aria-label="Duplicate policy action"
                      value={duplicateAction?.policy.kind ?? "none"}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          rules: current.rules.map((candidate) =>
                            candidate.id === rule.id
                              ? replaceRuleAction(
                                  candidate,
                                  duplicateActionFromSelection(
                                    event.target.value
                                  ),
                                  "duplicate"
                                )
                              : candidate
                          ),
                          updatedAt: Date.now()
                        }))
                      }
                    >
                      <option value="none">No override</option>
                      <option value="allow">Allow</option>
                      <option value="exactUrl">Exact URL</option>
                      <option value="fragmentlessUrl">Fragmentless URL</option>
                      <option value="domain">Domain only</option>
                      <option value="urlAndTitle">URL and title</option>
                      <option value="pattern">URL pattern</option>
                    </select>
                  </label>
                  {duplicateAction?.policy.kind === "pattern" && (
                    <label>
                      Duplicate pattern{" "}
                      <input
                        aria-label="Duplicate pattern"
                        value={duplicateAction.policy.pattern}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            rules: current.rules.map((candidate) =>
                              candidate.id === rule.id
                                ? replaceRuleAction(
                                    candidate,
                                    {
                                      kind: "setDuplicatePolicy",
                                      policy: {
                                        kind: "pattern",
                                        pattern: event.target.value
                                      }
                                    },
                                    "duplicate"
                                  )
                                : candidate
                            ),
                            updatedAt: Date.now()
                          }))
                        }
                      />
                    </label>
                  )}
                  <label>
                    Collapse action{" "}
                    <select
                      aria-label="Collapse action"
                      disabled={placement === "ungroup"}
                      value={
                        collapseAction
                          ? collapseAction.collapsed
                            ? "collapsed"
                            : "expanded"
                          : "none"
                      }
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          rules: current.rules.map((candidate) =>
                            candidate.id === rule.id
                              ? replaceRuleAction(
                                  candidate,
                                  event.target.value === "none"
                                    ? undefined
                                    : {
                                        kind: "setCollapsed",
                                        collapsed:
                                          event.target.value === "collapsed"
                                      },
                                  "collapse"
                                )
                              : candidate
                          ),
                          updatedAt: Date.now()
                        }))
                      }
                    >
                      <option value="none">Leave presentation unchanged</option>
                      <option value="expanded">Expand target group</option>
                      <option value="collapsed">Collapse target group</option>
                    </select>
                  </label>
                </>
              );
            })()}
            <h3>Positive expression</h3>
            <ConditionEditor
              node={rule.positive}
              path={[]}
              groups={configuration.groups}
              onChange={(path, update) =>
                changeCondition(rule.id, path, update)
              }
            />
            <h3>Negative expressions</h3>
            {rule.negative.length === 0 ? (
              <p className="empty">None</p>
            ) : (
              rule.negative.map((negative, index) => (
                <ConditionEditor
                  key={index}
                  node={negative}
                  path={[]}
                  groups={configuration.groups}
                  onChange={(path, update) =>
                    changeNegative(rule.id, index, path, update)
                  }
                />
              ))
            )}
            <button
              type="button"
              onClick={() =>
                changeRule(rule.id, {
                  negative: [
                    ...rule.negative,
                    {
                      kind: "any",
                      children: [
                        {
                          kind: "title",
                          operator: "contains",
                          value: "Blocked"
                        }
                      ]
                    }
                  ]
                })
              }
            >
              Add negative expression
            </button>
          </fieldset>
        ))}
      </section>
      <button type="button" className="save" onClick={save}>
        Save configuration
      </button>
    </main>
  );
}
