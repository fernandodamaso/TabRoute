import type { Configuration, ManagedGroup, Rule, UUID } from "../../domain/types";

export type ManagerRoute = "groups" | "rules" | "activity" | "settings";

export interface ManagerViewMetadata {
  width: 520;
  height: 600;
  headerHeight: 52;
  navigationHeight: 42;
  defaultRoute: "groups";
  routes: readonly ManagerRoute[];
}

export interface ManagerQuery { kind: "manager-query"; }

export type ManagedGroupPatch = Partial<Pick<ManagedGroup,
  "name" | "emoji" | "color" | "enabled" | "isPersistent" |
  "defaultOrder" | "defaultCollapsed" | "pausedUntil"
>>;

export type RuleDraft = Omit<Rule, "id" | "createdAt" | "updatedAt"> & {
  id?: UUID;
  createdAt?: number;
  updatedAt?: number;
};

export type ManagerCommandPayload =
  | { kind: "updateGroup"; groupId: UUID; patch: ManagedGroupPatch }
  | { kind: "createGroup"; input: { name: string; color: ManagedGroup["color"]; emoji?: string; isPersistent?: boolean; defaultCollapsed?: boolean } }
  | { kind: "deleteGroup"; groupId: UUID }
  | { kind: "saveRule"; rule: RuleDraft }
  | { kind: "duplicateRule"; ruleId: UUID }
  | { kind: "deleteRule"; ruleId: UUID }
  | { kind: "setRuleEnabled"; ruleId: UUID; enabled: boolean }
  | { kind: "setRulePaused"; ruleId: UUID; pausedUntil?: number | "restart" };

export interface ManagerCommand {
  kind: "manager-command";
  command: ManagerCommandPayload;
}

export type ManagerMessage = ManagerQuery | ManagerCommand;

export interface ManagerSuccess {
  ok: true;
  configuration: Configuration;
  view: ManagerViewMetadata;
}

export interface ManagerFailure {
  ok: false;
  error: { kind: "validation" | "reference" | "persistence"; message: string; field?: string };
}

export type ManagerResponse = ManagerSuccess | ManagerFailure;
