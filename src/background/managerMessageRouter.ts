import { createManagedGroup, removeManagedGroup, updateManagedGroup } from "../domain/defaults";
import { validateConfiguration } from "../domain/schemas";
import type { Configuration, UUID } from "../domain/types";
import { validateRuleActions } from "../rules/ruleEngine";
import type { ManagerCommandPayload, ManagerMessage, ManagerResponse, ManagerSuccess, RuleDraft } from "../ui/manager/types";

const view = {
  width: 520,
  height: 600,
  headerHeight: 52,
  navigationHeight: 42,
  defaultRoute: "groups",
  routes: ["groups", "rules", "activity", "settings"] as const
} satisfies ManagerSuccess["view"];

interface ManagerRepository { save(configuration: Configuration): Promise<void>; }
interface ManagerController {
  getConfiguration(): Configuration;
  replaceConfiguration(configuration: Configuration): Promise<void>;
}

function isUuid(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function success(configuration: Configuration): ManagerSuccess {
  return { ok: true, configuration, view };
}

type ManagerFailureKind = "validation" | "reference" | "persistence";
function failure(kind: ManagerFailureKind, error: unknown): ManagerResponse {
  return { ok: false, error: { kind, message: error instanceof Error ? error.message : "manager command failed" } };
}

function domainFailure(error: unknown): ManagerResponse {
  const kind: ManagerFailureKind = error instanceof Error && /not found|missing/.test(error.message)
    ? "reference"
    : "validation";
  return failure(kind, error);
}

function ruleFromDraft(draft: RuleDraft, randomUuid: () => string, now: () => number) {
  const timestamp = now();
  return {
    ...draft,
    id: draft.id ?? (randomUuid() as UUID),
    createdAt: draft.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function updateRule(configuration: Configuration, ruleId: UUID, patch: Partial<Configuration["rules"][number]>, now: () => number) {
  if (!configuration.rules.some((rule) => rule.id === ruleId)) throw new Error("rule not found");
  const timestamp = now();
  return {
    ...configuration,
    rules: configuration.rules.map((rule) => rule.id === ruleId ? { ...rule, ...patch, updatedAt: timestamp } : rule),
    updatedAt: timestamp
  };
}

function applyCommand(current: Configuration, command: ManagerCommandPayload, randomUuid: () => string, now: () => number): Configuration {
  switch (command.kind) {
    case "updateGroup":
      if (!isUuid(command.groupId)) throw new Error("group id must be a UUID");
      return updateManagedGroup(current, command.groupId, command.patch, now);
    case "createGroup":
      return createManagedGroup(current, command.input, randomUuid, now);
    case "deleteGroup":
      if (!isUuid(command.groupId)) throw new Error("group id must be a UUID");
      return removeManagedGroup(current, command.groupId, now);
    case "saveRule": {
      if (command.rule.id !== undefined && !isUuid(command.rule.id)) throw new Error("rule id must be a UUID");
      validateRuleActions(command.rule.actions);
      const rule = ruleFromDraft(command.rule, randomUuid, now);
      const exists = current.rules.some((candidate) => candidate.id === rule.id);
      return { ...current, rules: exists ? current.rules.map((candidate) => candidate.id === rule.id ? rule : candidate) : [...current.rules, rule], updatedAt: now() };
    }
    case "duplicateRule": {
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      const source = current.rules.find((candidate) => candidate.id === command.ruleId);
      if (!source) throw new Error("rule not found");
      const timestamp = now();
      return { ...current, rules: [...current.rules, { ...source, id: randomUuid() as UUID, createdAt: timestamp, updatedAt: timestamp }], updatedAt: timestamp };
    }
    case "deleteRule":
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      if (!current.rules.some((candidate) => candidate.id === command.ruleId)) throw new Error("rule not found");
      return { ...current, rules: current.rules.filter((candidate) => candidate.id !== command.ruleId), updatedAt: now() };
    case "setRuleEnabled":
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      return updateRule(current, command.ruleId, { enabled: command.enabled }, now);
    case "setRulePaused":
      if (!isUuid(command.ruleId)) throw new Error("rule id must be a UUID");
      return updateRule(current, command.ruleId, { pausedUntil: command.pausedUntil }, now);
  }
}

export function createManagerMessageRouter(input: {
  repository: ManagerRepository;
  controller: ManagerController;
  randomUuid?: () => string;
  now?: () => number;
}) {
  const randomUuid = input.randomUuid ?? (() => crypto.randomUUID());
  const now = input.now ?? Date.now;
  let mutationTail: Promise<void> = Promise.resolve();
  return {
    handle(message: ManagerMessage): Promise<ManagerResponse> {
      const run = async (): Promise<ManagerResponse> => {
        let current: Configuration;
        try {
          current = validateConfiguration(input.controller.getConfiguration());
          if (message.kind === "manager-query") return success(current);
        } catch (error) {
          return domainFailure(error);
        }

        let next: Configuration;
        try {
          next = validateConfiguration(applyCommand(current, message.command, randomUuid, now));
        } catch (error) {
          return domainFailure(error);
        }

        try {
          await input.repository.save(next);
        } catch (error) {
          return failure("persistence", error);
        }

        try {
          await input.controller.replaceConfiguration(next);
        } catch {
          // Persistence is authoritative. The concrete controller installs the
          // accepted configuration before reconciliation, so a later Chrome
          // reconciliation failure must not make a durable command retryable.
        }
        return success(next);
      };

      if (message.kind === "manager-query") return run();
      const queued = mutationTail.then(run, run);
      mutationTail = queued.then(() => undefined, () => undefined);
      return queued;
    }
  };
}
