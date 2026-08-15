import type { Configuration, UUID } from "../domain/types";
import type { SessionRepository } from "./sessionRepository";

const RULE_IDS_KEY = "restartPausedRuleIds";
const GROUP_IDS_KEY = "restartPausedGroupIds";
const GLOBAL_KEY = "globalPausedUntilRestart";

export interface RestartPauseState {
  global: boolean;
  ruleIds: UUID[];
  groupIds: UUID[];
}

function uuidList(value: unknown): UUID[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is UUID => typeof candidate === "string")
    : [];
}

export async function loadRestartPauseState(
  session: SessionRepository
): Promise<RestartPauseState> {
  const runtime = await session.loadRuntime();
  return {
    global: runtime[GLOBAL_KEY] === true,
    ruleIds: uuidList(runtime[RULE_IDS_KEY]),
    groupIds: uuidList(runtime[GROUP_IDS_KEY])
  };
}

async function updateIds(
  session: SessionRepository,
  key: typeof RULE_IDS_KEY | typeof GROUP_IDS_KEY,
  id: UUID,
  paused: boolean
): Promise<void> {
  const runtime = await session.loadRuntime();
  const ids = uuidList(runtime[key]);
  const next = paused
    ? ids.includes(id)
      ? ids
      : [...ids, id]
    : ids.filter((candidate) => candidate !== id);
  await session.updateRuntime({ [key]: next });
}

export function setRuleRestartPause(
  session: SessionRepository,
  ruleId: UUID,
  paused: boolean
): Promise<void> {
  return updateIds(session, RULE_IDS_KEY, ruleId, paused);
}

export function setGroupRestartPause(
  session: SessionRepository,
  groupId: UUID,
  paused: boolean
): Promise<void> {
  return updateIds(session, GROUP_IDS_KEY, groupId, paused);
}

export async function setGlobalRestartPause(
  session: SessionRepository,
  paused: boolean
): Promise<void> {
  await session.updateRuntime({ [GLOBAL_KEY]: paused });
}

export function overlayRestartPauses(
  configuration: Configuration,
  state: RestartPauseState
): Configuration {
  return {
    ...configuration,
    ...(state.global ? { globalPausedUntil: "restart" as const } : {}),
    groups: configuration.groups.map((group) =>
      state.groupIds.includes(group.id)
        ? { ...group, pausedUntil: "restart" as const }
        : group
    ),
    rules: configuration.rules.map((rule) =>
      state.ruleIds.includes(rule.id)
        ? { ...rule, pausedUntil: "restart" as const }
        : rule
    )
  };
}
