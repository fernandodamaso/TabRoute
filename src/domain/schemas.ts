import { z } from "zod";
import type { Configuration } from "./types";

const uuid = z.string().uuid();
const managedGroup = z.object({
  schemaVersion: z.literal(1), id: uuid, name: z.string().min(1), emoji: z.string().optional(),
  color: z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]),
  isFallback: z.boolean(), isPersistent: z.boolean(), defaultOrder: z.number().int(), defaultCollapsed: z.boolean(),
  createdAt: z.number(), updatedAt: z.number()
});

const configuration = z.object({
  schemaVersion: z.literal(1), fallbackGroupId: uuid, automationEnabled: z.boolean(),
  globalPausedUntil: z.union([z.number(), z.literal("restart")]).optional(), groups: z.array(managedGroup),
  rules: z.array(z.never()), persistentTabs: z.array(z.never()),
  duplicateSettings: z.object({ globalPolicy: z.object({ kind: z.literal("allow") }), globalExclusions: z.array(z.string()), trackingParameters: z.array(z.string()) }),
  templates: z.array(z.never()), snapshotIntervalMinutes: z.number().positive(), activityLimit: z.literal(500), snapshotLimit: z.literal(50), undoTtlMs: z.literal(30000),
  createdAt: z.number(), updatedAt: z.number()
}).superRefine((value, context) => {
  const fallbackGroups = value.groups.filter((group) => group.isFallback);
  if (fallbackGroups.length !== 1 || fallbackGroups[0]?.id !== value.fallbackGroupId) {
    context.addIssue({ code: "custom", message: "configuration must contain exactly one fallback group" });
  }
});

export function validateConfiguration(value: unknown): Configuration {
  return configuration.parse(value) as Configuration;
}
