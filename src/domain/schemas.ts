import { z } from "zod";
import type { Configuration, ConditionNode } from "./types";

const uuid = z.string().uuid();
const pauseValue = z.number().int().nonnegative();
const duplicatePolicy = z.union([
  z.strictObject({ kind: z.literal("allow") }),
  z.strictObject({ kind: z.literal("exactUrl") }),
  z.strictObject({ kind: z.literal("fragmentlessUrl") }),
  z.strictObject({ kind: z.literal("domain") }),
  z.strictObject({ kind: z.literal("urlAndTitle") }),
  z.strictObject({ kind: z.literal("pattern"), pattern: z.string().min(1) })
]);
const placement = z.union([
  z.strictObject({ kind: z.literal("managed"), managedGroupId: uuid }),
  z.strictObject({ kind: z.literal("unmanaged") }),
  z.strictObject({ kind: z.literal("ungrouped") })
]);
const httpUrlValue = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "exact URL conditions require an absolute HTTP(S) URL" }
  );
const conditionNode: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.strictObject({
      kind: z.enum(["all", "any"]),
      children: z.array(conditionNode).min(1)
    }),
    z.strictObject({
      kind: z.literal("url"),
      operator: z.literal("exact"),
      value: httpUrlValue
    }),
    z.strictObject({
      kind: z.literal("url"),
      operator: z.enum(["pattern", "regex"]),
      value: z.string().min(1)
    }),
    z.strictObject({
      kind: z.literal("host"),
      operator: z.enum(["exact", "suffix"]),
      value: z.string().min(1)
    }),
    z.strictObject({
      kind: z.literal("path"),
      operator: z.enum(["exact", "prefix"]),
      value: z.string().min(1)
    }),
    z.strictObject({
      kind: z.literal("title"),
      operator: z.enum(["contains", "exact", "regex"]),
      value: z.string().min(1)
    }),
    z.strictObject({ kind: z.literal("pinned"), value: z.boolean() }),
    z.strictObject({
      kind: z.literal("openerUrl"),
      operator: z.literal("exact"),
      value: httpUrlValue
    }),
    z.strictObject({
      kind: z.literal("openerUrl"),
      operator: z.enum(["pattern", "suffix"]),
      value: z.string().min(1)
    }),
    z.strictObject({
      kind: z.literal("openerHost"),
      operator: z.enum(["exact", "pattern", "suffix"]),
      value: z.string().min(1)
    }),
    z.strictObject({ kind: z.literal("currentGroup"), placement })
  ])
);
const ruleAction = z.union([
  z.strictObject({ kind: z.literal("group") }),
  z.strictObject({ kind: z.literal("ungroup") }),
  z.strictObject({ kind: z.literal("makePersistent") }),
  z.strictObject({
    kind: z.literal("setDuplicatePolicy"),
    policy: duplicatePolicy
  }),
  z.strictObject({ kind: z.literal("setCollapsed"), collapsed: z.boolean() })
]);
const managedGroup = z.strictObject({
  schemaVersion: z.literal(1),
  id: uuid,
  name: z.string().min(1),
  emoji: z.string().optional(),
  color: z.enum([
    "grey",
    "blue",
    "red",
    "yellow",
    "green",
    "pink",
    "purple",
    "cyan",
    "orange"
  ]),
  isFallback: z.boolean(),
  enabled: z.boolean().default(true),
  isPersistent: z.boolean(),
  defaultOrder: z.number().int(),
  defaultCollapsed: z.boolean(),
  duplicatePolicy: duplicatePolicy.optional(),
  pausedUntil: pauseValue.optional(),
  createdAt: z.number(),
  updatedAt: z.number()
});

const rule = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: uuid,
    targetGroupId: uuid,
    priority: z.number().int(),
    positive: conditionNode,
    negative: z.array(conditionNode),
    actions: z.array(ruleAction),
    duplicatePolicy: duplicatePolicy.optional(),
    enabled: z.boolean(),
    pausedUntil: pauseValue.optional(),
    createdAt: z.number(),
    updatedAt: z.number()
  })
  .superRefine((value, context) => {
    const placements = value.actions.filter(
      (action) => action.kind === "group" || action.kind === "ungroup"
    );
    if (placements.length !== 1)
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "rule must contain exactly one placement action"
      });
    const hasUngroup = placements[0]?.kind === "ungroup";
    if (
      hasUngroup &&
      value.actions.some(
        (action) =>
          action.kind === "makePersistent" || action.kind === "setCollapsed"
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "makePersistent and setCollapsed require group placement"
      });
    }
    if (
      value.actions.filter((action) => action.kind === "setDuplicatePolicy")
        .length > 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "at most one duplicate policy action is allowed"
      });
    }
    if (
      value.actions.filter((action) => action.kind === "setCollapsed").length >
      1
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "at most one collapse action is allowed"
      });
    }
    const regexes = [
      ...collectRegexes(value.positive as ConditionNode),
      ...value.negative.flatMap((node) => collectRegexes(node as ConditionNode))
    ];
    for (const expression of regexes) {
      try {
        new RegExp(expression);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["positive"],
          message: `invalid regular expression: ${expression}`
        });
      }
    }
  });

function collectRegexes(node: ConditionNode): string[] {
  if (node.kind === "all" || node.kind === "any")
    return node.children.flatMap(collectRegexes);
  if (
    (node.kind === "url" || node.kind === "title") &&
    node.operator === "regex"
  )
    return [node.value];
  return [];
}

const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "persistent canonical URL must use HTTP(S)");

const persistentTab = z.strictObject({
  schemaVersion: z.literal(1),
  id: uuid,
  managedGroupId: uuid,
  canonicalUrl: httpUrl,
  acceptedPatterns: z.array(z.string()),
  order: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number()
});

function addDuplicateIdIssues(
  ids: readonly string[],
  collection: "groups" | "rules" | "persistentTabs",
  context: z.RefinementCtx
) {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        path: [collection, index, "id"],
        message: `${collection} must use unique durable UUIDs`
      });
    }
    seen.add(id);
  });
}

const configuration = z
  .strictObject({
    schemaVersion: z.literal(1),
    fallbackGroupId: uuid,
    automationEnabled: z.boolean(),
    globalPausedUntil: pauseValue.optional(),
    groups: z.array(managedGroup),
    rules: z.array(rule),
    persistentTabs: z.array(persistentTab),
    restorePersistentGroups: z.boolean().optional(),
    duplicateSettings: z.strictObject({
      globalPolicy: duplicatePolicy,
      globalExclusions: z.array(z.string()),
      trackingParameters: z.array(z.string())
    }),
    templates: z.array(z.never()),
    snapshotIntervalMinutes: z.number().positive(),
    activityLimit: z.literal(500),
    snapshotLimit: z.literal(50),
    undoTtlMs: z.literal(30000),
    createdAt: z.number(),
    updatedAt: z.number()
  })
  .superRefine((value, context) => {
    addDuplicateIdIssues(
      value.groups.map((group) => group.id),
      "groups",
      context
    );
    addDuplicateIdIssues(
      value.rules.map((rule) => rule.id),
      "rules",
      context
    );
    addDuplicateIdIssues(
      value.persistentTabs.map((tab) => tab.id),
      "persistentTabs",
      context
    );

    const fallbackGroups = value.groups.filter((group) => group.isFallback);
    if (
      fallbackGroups.length !== 1 ||
      fallbackGroups[0]?.id !== value.fallbackGroupId
    ) {
      context.addIssue({
        code: "custom",
        message: "configuration must contain exactly one fallback group"
      });
    }
    const groupIds = new Set(value.groups.map((group) => group.id));
    value.rules.forEach((rule, index) => {
      if (!groupIds.has(rule.targetGroupId))
        context.addIssue({
          code: "custom",
          path: ["rules", index, "targetGroupId"],
          message: "rule target group does not exist"
        });
    });
    const persistentGroupIds = new Set(value.groups.map((group) => group.id));
    value.persistentTabs.forEach((tab, index) => {
      if (!persistentGroupIds.has(tab.managedGroupId)) {
        context.addIssue({
          code: "custom",
          path: ["persistentTabs", index, "managedGroupId"],
          message: "persistent tab group does not exist"
        });
      }
    });
  });

export function validateConfiguration(value: unknown): Configuration {
  const parsed = configuration.parse(value) as Configuration;
  return {
    ...parsed,
    restorePersistentGroups: parsed.restorePersistentGroups ?? true
  };
}
