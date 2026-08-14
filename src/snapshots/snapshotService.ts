import { captureSnapshot } from "./captureSnapshot";
import { planSnapshotRestore } from "./restoreSnapshot";
import { buildActionPlan } from "../actions/buildActionPlan";
import {
  executeActionPlan,
  type ActionEngineDeps
} from "../actions/executeActionPlan";
import { reconstructAssociations } from "../chrome/reconstructAssociations";
import { createUuid } from "../domain/ids";
import type {
  BrowserInventory,
  ChromeInventory,
  Configuration,
  Snapshot,
  SnapshotScope,
  UUID
} from "../domain/types";
import type { LocalRepository } from "../state/localRepository";
import type { SessionRepository } from "../state/sessionRepository";
import type { SnapshotContext } from "./checkpointService";
import { buildRestoreContext } from "../controller/persistentRepairRunner";
import { observeInventory } from "../duplicates/observations";

export type SnapshotCommandResult =
  | { ok: true; snapshot?: Snapshot }
  | { ok: false; code: string; message?: string };

export function listUserSnapshots(snapshots: readonly Snapshot[]): Snapshot[] {
  return snapshots
    .filter(
      (snapshot) => snapshot.kind === "named" || snapshot.kind === "automatic"
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function saveNamedSnapshot(input: {
  local: LocalRepository;
  name: string;
  scope: SnapshotScope;
  inventory: BrowserInventory;
  context: SnapshotContext;
  now?: () => number;
  id?: UUID;
}): Promise<SnapshotCommandResult> {
  const now = input.now ?? Date.now;
  const timestamp = now();
  const snapshot = captureSnapshot(
    input.scope,
    input.inventory,
    input.context,
    {
      id: input.id ?? createUuid(),
      name: input.name.trim(),
      kind: "named",
      now: timestamp
    }
  );
  if (!snapshot.name) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "snapshot name is required"
    };
  }
  const result = await input.local.saveSnapshot(snapshot);
  if (!result.ok) {
    return { ok: false, code: result.code };
  }
  return { ok: true, snapshot };
}

export async function captureAutomaticSnapshot(input: {
  local: LocalRepository;
  inventory: BrowserInventory;
  context: SnapshotContext;
  now?: () => number;
}): Promise<SnapshotCommandResult> {
  const snapshots = await input.local.listSnapshots();
  const userSnapshots = listUserSnapshots(snapshots);
  if (
    userSnapshots.length >= 50 &&
    !userSnapshots.some((snapshot) => snapshot.kind === "automatic")
  ) {
    return { ok: false, code: "SNAPSHOT_LIMIT" };
  }
  const now = input.now ?? Date.now;
  const timestamp = now();
  const snapshot = captureSnapshot(
    { kind: "browser" },
    input.inventory,
    input.context,
    {
      id: createUuid(),
      name: `Automatic ${new Date(timestamp).toISOString()}`,
      kind: "automatic",
      now: timestamp
    }
  );
  const result = await input.local.saveSnapshot(snapshot);
  if (!result.ok) {
    return { ok: false, code: result.code };
  }
  return { ok: true, snapshot };
}

export async function updateSnapshotFromInventory(input: {
  local: LocalRepository;
  snapshotId: UUID;
  inventory: BrowserInventory;
  context: SnapshotContext;
  now?: () => number;
}): Promise<SnapshotCommandResult> {
  const existing = await input.local.getSnapshot(input.snapshotId);
  if (!existing || existing.kind === "checkpoint") {
    return { ok: false, code: "REFERENCE", message: "snapshot not found" };
  }
  const now = input.now ?? Date.now;
  const timestamp = now();
  const snapshot = captureSnapshot(
    existing.scope,
    input.inventory,
    input.context,
    {
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      now: timestamp
    }
  );
  snapshot.createdAt = existing.createdAt;
  snapshot.updatedAt = timestamp;
  const result = await input.local.saveSnapshot(snapshot);
  if (!result.ok) {
    return { ok: false, code: result.code };
  }
  return { ok: true, snapshot };
}

export async function renameSnapshotRecord(input: {
  local: LocalRepository;
  snapshotId: UUID;
  name: string;
  now?: () => number;
}): Promise<SnapshotCommandResult> {
  const existing = await input.local.getSnapshot(input.snapshotId);
  if (!existing || existing.kind === "checkpoint") {
    return { ok: false, code: "REFERENCE", message: "snapshot not found" };
  }
  const trimmed = input.name.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "snapshot name is required"
    };
  }
  const snapshot: Snapshot = {
    ...existing,
    name: trimmed,
    updatedAt: input.now?.() ?? Date.now()
  };
  const result = await input.local.saveSnapshot(snapshot);
  if (!result.ok) {
    return { ok: false, code: result.code };
  }
  return { ok: true, snapshot };
}

export async function deleteSnapshotRecord(input: {
  local: LocalRepository;
  snapshotId: UUID;
}): Promise<SnapshotCommandResult> {
  const existing = await input.local.getSnapshot(input.snapshotId);
  if (!existing || existing.kind === "checkpoint") {
    return { ok: false, code: "REFERENCE", message: "snapshot not found" };
  }
  await input.local.deleteSnapshot(input.snapshotId);
  return { ok: true };
}

export async function restoreSnapshotFromRecord(input: {
  local: LocalRepository;
  session: SessionRepository;
  snapshotId: UUID;
  actionDeps: ActionEngineDeps;
  now?: () => number;
}): Promise<SnapshotCommandResult> {
  const snapshot = await input.local.getSnapshot(input.snapshotId);
  if (!snapshot || snapshot.kind === "checkpoint") {
    return { ok: false, code: "REFERENCE", message: "snapshot not found" };
  }
  const inventory = await input.actionDeps.reads.readInventory();
  const runtime = await input.session.loadSession();
  const { inventory: browserInventory } = observeInventory(inventory, runtime);
  const associations = reconstructAssociations(
    inventory,
    input.actionDeps.configuration
  );
  const context = await buildRestoreContext({
    configuration: input.actionDeps.configuration,
    inventory,
    session: runtime,
    local: input.local,
    associations
  });
  const planResult = planSnapshotRestore(snapshot, browserInventory, {
    ...context,
    session: runtime
  });
  if (!planResult.ok) {
    return { ok: false, code: planResult.code };
  }
  if (planResult.actions.length === 0) {
    return { ok: true };
  }
  const actionPlan = buildActionPlan("snapshot", planResult.actions, {
    requireCheckpoint: true
  });
  const result = await executeActionPlan(actionPlan, input.actionDeps);
  if (result.status === "failure") {
    return { ok: false, code: result.errorCode ?? "RESTORE_FAILED" };
  }
  return { ok: true };
}

export async function buildSnapshotContext(input: {
  configuration: Configuration;
  local: LocalRepository;
  inventory?: ChromeInventory;
}): Promise<SnapshotContext> {
  return {
    configuration: input.configuration,
    ownership: await input.local.loadWindowOwnership(),
    associations: input.inventory
      ? reconstructAssociations(input.inventory, input.configuration)
      : []
  };
}
