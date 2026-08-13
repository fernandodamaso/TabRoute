import { createDefaultConfiguration } from "../domain/defaults";
import { validateConfiguration } from "../domain/schemas";
import type { Configuration } from "../domain/types";
import {
  ConfigurationRevisionError,
  canonicalConfigurationJson,
  decodeConfigurationRevision,
  encodeConfigurationRevision,
  sha256,
  type ConfigurationShadow,
  type ConfigurationSyncHead
} from "./configurationShards";
import {
  STORAGE_KEYS,
  SYNC_KEYS,
  SYNC_LIMITS,
  type ChromeStoragePort
} from "./keys";
import {
  createChromeSessionRepository,
  type SessionRepository
} from "./sessionRepository";

export type SyncChangeResult =
  | { kind: "applied"; configuration: Configuration; revisionId: string }
  | { kind: "already-applied"; configuration: Configuration; revisionId?: string }
  | { kind: "pending"; configuration: Configuration; revisionId?: string }
  | { kind: "invalid"; configuration: Configuration; reason: string }
  | { kind: "ignored"; configuration: Configuration };

export interface ConfigurationRepository {
  loadOrCreate(): Promise<Configuration>;
  save(configuration: Configuration): Promise<void>;
  applySyncChange(changedKeys?: readonly string[]): Promise<SyncChangeResult>;
  markControllerRevisionApplied(revisionId: string): Promise<void>;
  getConfiguration(): Configuration;
}

interface LegacyConfigurationStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

type RepositoryStorage = ChromeStoragePort | LegacyConfigurationStorage;

export class ConfigurationStorageError extends Error {
  constructor(
    readonly code:
      | "SYNC_ITEM_QUOTA"
      | "SYNC_TOTAL_QUOTA"
      | "SYNC_ITEM_COUNT"
      | "SYNC_WRITE",
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ConfigurationStorageError";
  }
}

function isChromeStorage(storage: RepositoryStorage): storage is ChromeStoragePort {
  return "sync" in storage && "local" in storage && "session" in storage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isHead(value: unknown): value is ConfigurationSyncHead {
  if (!isRecord(value)) return false;
  const fields = [
    "schemaVersion",
    "revisionId",
    "shardKeys",
    "shardCount",
    "checksum",
    "updatedAt"
  ];
  return (
    Object.keys(value).every((key) => fields.includes(key)) &&
    fields.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    value.schemaVersion === 1 &&
    typeof value.revisionId === "string" &&
    Array.isArray(value.shardKeys) &&
    Number.isInteger(value.shardCount) &&
    typeof value.checksum === "string" &&
    Number.isFinite(value.updatedAt)
  );
}

function measuredBytes(key: string, value: unknown): number {
  return new TextEncoder().encode(key).byteLength +
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function shadowFor(
  configuration: Configuration,
  revisionId: string,
  checksum: string,
  updatedAt = Date.now()
): ConfigurationShadow {
  return {
    schemaVersion: 1,
    revisionId,
    checksum,
    configuration: validateConfiguration(configuration),
    updatedAt
  };
}

function shadowMatchesHead(shadow: ConfigurationShadow | undefined, head: ConfigurationSyncHead) {
  return !!shadow && shadow.revisionId === head.revisionId && shadow.checksum === head.checksum;
}

function mapSyncWriteError(error: unknown): ConfigurationStorageError {
  const message = error instanceof Error ? error.message : String(error);
  if (/PER_ITEM|per item|8192/i.test(message))
    return new ConfigurationStorageError("SYNC_ITEM_QUOTA", message, { cause: error });
  if (/MAX_ITEMS|item.?count|512/i.test(message))
    return new ConfigurationStorageError("SYNC_ITEM_COUNT", message, { cause: error });
  if (/QUOTA_BYTES|total quota|102400/i.test(message))
    return new ConfigurationStorageError("SYNC_TOTAL_QUOTA", message, { cause: error });
  return new ConfigurationStorageError("SYNC_WRITE", "Sync configuration write failed", { cause: error });
}

export function createConfigurationRepository(input: {
  storage: RepositoryStorage;
  createDefault?: () => Configuration;
  now?: () => number;
  sessionRepository?: Pick<SessionRepository, "loadRuntime" | "updateRuntime">;
}): ConfigurationRepository {
  const createDefault = input.createDefault ?? (() => createDefaultConfiguration());
  const now = input.now ?? Date.now;
  const areas = isChromeStorage(input.storage) ? input.storage : undefined;
  const chromeStorage = areas !== undefined;
  const legacy = areas ? undefined : input.storage as LegacyConfigurationStorage;
  const sync = areas?.sync;
  const sessionRepository =
    input.sessionRepository ??
    (areas ? createChromeSessionRepository(areas.session) : undefined);
  let configuration = validateConfiguration(createDefault());
  let activeRevisionId: string | undefined;
  let saveQueue: Promise<unknown> = Promise.resolve();

  async function readShadow(): Promise<ConfigurationShadow | undefined> {
    if (!chromeStorage) return undefined;
    const stored = await areas!.local.get(STORAGE_KEYS.localConfigurationShadow);
    const shadow = stored[STORAGE_KEYS.localConfigurationShadow];
    if (!isRecord(shadow)) return undefined;
    const fields = ["schemaVersion", "revisionId", "checksum", "configuration", "updatedAt"];
    if (
      Object.keys(shadow).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.prototype.hasOwnProperty.call(shadow, key)) ||
      shadow.schemaVersion !== 1 ||
      typeof shadow.revisionId !== "string" ||
      !/^[a-f0-9]{64}$/i.test(String(shadow.checksum)) ||
      typeof shadow.updatedAt !== "number" ||
      !Number.isFinite(shadow.updatedAt)
    )
      return undefined;
    try {
      const validatedConfiguration = validateConfiguration(shadow.configuration);
      if (
        (await sha256(canonicalConfigurationJson(validatedConfiguration))) !==
        shadow.checksum
      )
        return undefined;
      return {
        schemaVersion: 1,
        revisionId: String(shadow.revisionId),
        checksum: String(shadow.checksum),
        configuration: validatedConfiguration,
        updatedAt: Number(shadow.updatedAt)
      };
    } catch {
      return undefined;
    }
  }

  async function readRuntime(): Promise<Record<string, unknown>> {
    return sessionRepository ? sessionRepository.loadRuntime() : {};
  }

  async function updateRuntime(patch: Record<string, unknown>): Promise<void> {
    if (sessionRepository) await sessionRepository.updateRuntime(patch);
  }

  function isIncompleteSyncReason(reason: string): boolean {
    return reason.toLowerCase().includes("incomplete");
  }

  async function recordInvalidSyncRuntime(input: {
    head?: ConfigurationSyncHead;
    reason: string;
  }): Promise<void> {
    if (isIncompleteSyncReason(input.reason)) {
      await updateRuntime({
        ...(input.head ? { pendingSyncRevision: input.head.revisionId } : {}),
        lastSyncInvalid: false
      });
      return;
    }
    await updateRuntime({
      lastSyncInvalid: true,
      pendingSyncRevision: undefined
    });
  }

  async function readCandidate(): Promise<
    | { kind: "missing" }
    | { kind: "valid"; head: ConfigurationSyncHead; configuration: Configuration; migrated: boolean }
    | { kind: "invalid"; head?: ConfigurationSyncHead; reason: string }
  > {
    if (!sync) return { kind: "missing" };
    const stored = await sync.get(SYNC_KEYS.configurationHead);
    const rawHead = stored[SYNC_KEYS.configurationHead];
    if (rawHead === undefined) return { kind: "missing" };
    if (!isHead(rawHead)) return { kind: "invalid", reason: "Sync head is malformed" };
    const head = rawHead;
    if (measuredBytes(SYNC_KEYS.configurationHead, head) > SYNC_LIMITS.hardItemBytes)
      return { kind: "invalid", head, reason: "Sync head exceeds Chrome quota" };
    if (
      !Array.isArray(head.shardKeys) ||
      head.shardKeys.length !== head.shardCount ||
      head.shardCount < 1
    )
      return { kind: "invalid", head, reason: "Sync head is malformed" };
    try {
      const shards = await sync.get(head.shardKeys);
      const decoded = await decodeConfigurationRevision(head, shards);
      return { kind: "valid", head, ...decoded };
    } catch (error) {
      return {
        kind: "invalid",
        head,
        reason: error instanceof Error ? error.message : "Sync revision is invalid"
      };
    }
  }

  async function writeShadow(shadow: ConfigurationShadow): Promise<void> {
    if (!areas) return;
    await areas.local.set({ [STORAGE_KEYS.localConfigurationShadow]: shadow });
  }

  async function saveLegacy(next: Configuration): Promise<void> {
    await legacy!.set({ [STORAGE_KEYS.legacyConfiguration]: validateConfiguration(next) });
  }

  async function saveSync(next: Configuration): Promise<void> {
    if (!sync) {
      await saveLegacy(next);
      configuration = validateConfiguration(next);
      return;
    }
    const normalized = validateConfiguration(next);
    const revisionId = crypto.randomUUID();
    let encoded;
    try {
      encoded = await encodeConfigurationRevision(normalized, revisionId, now());
    } catch (error) {
      if (error instanceof ConfigurationRevisionError)
        throw new ConfigurationStorageError("SYNC_ITEM_QUOTA", error.message, { cause: error });
      throw mapSyncWriteError(error);
    }
    const existing = await sync.get();
    const previousHead = isHead(existing[SYNC_KEYS.configurationHead])
      ? existing[SYNC_KEYS.configurationHead] as ConfigurationSyncHead
      : undefined;
    const previousShadow = await readShadow();
    const shardEntries = Object.entries(encoded.shards);
    const stagedEntries = Object.entries(existing).filter(([key]) => key !== SYNC_KEYS.configurationHead);
    const staged = new Map(stagedEntries);
    for (const [key, value] of shardEntries) staged.set(key, value);
    staged.set(SYNC_KEYS.configurationHead, encoded.head);
    const stagedBytes = [...staged].reduce((total, [key, value]) => total + measuredBytes(key, value), 0);
    const stagedCount = staged.size;
    let rolledOver = false;

    if (stagedBytes > SYNC_LIMITS.maxTotalBytes || stagedCount > SYNC_LIMITS.maxItems) {
      const canRollover =
        !!previousHead &&
        shadowMatchesHead(previousShadow, previousHead) &&
        previousHead.shardKeys.every((key) => key in existing);
      if (!canRollover)
        throw new ConfigurationStorageError(
          stagedCount > SYNC_LIMITS.maxItems ? "SYNC_ITEM_COUNT" : "SYNC_TOTAL_QUOTA",
          stagedCount > SYNC_LIMITS.maxItems
            ? "Sync item-count quota would be exceeded"
            : "Sync total quota would be exceeded"
        );
      await sync.remove(previousHead.shardKeys);
      rolledOver = true;
      const afterRemoval = await sync.get();
      const finalEntries = Object.entries(afterRemoval).filter(([key]) => key !== SYNC_KEYS.configurationHead);
      const finalBytes = finalEntries.reduce((total, [key, value]) => total + measuredBytes(key, value), 0) +
        shardEntries.reduce((total, [key, value]) => total + measuredBytes(key, value), 0) +
        measuredBytes(SYNC_KEYS.configurationHead, encoded.head);
      const finalCount = finalEntries.length + shardEntries.length + 1;
      if (finalBytes > SYNC_LIMITS.maxTotalBytes)
        throw new ConfigurationStorageError("SYNC_TOTAL_QUOTA", "Sync total quota would be exceeded");
      if (finalCount > SYNC_LIMITS.maxItems)
        throw new ConfigurationStorageError("SYNC_ITEM_COUNT", "Sync item-count quota would be exceeded");
    }

    try {
      await updateRuntime({
        lastLocallyAuthoredSyncRevisionId: revisionId,
        pendingSyncRevision: undefined,
        lastSyncInvalid: false
      });
      await sync.set(Object.fromEntries(shardEntries));
      const stagedShards = await sync.get(encoded.head.shardKeys);
      await decodeConfigurationRevision(encoded.head, stagedShards);
      await sync.set({ [SYNC_KEYS.configurationHead]: encoded.head });
      const publishedHead = await sync.get(SYNC_KEYS.configurationHead);
      const published = publishedHead[SYNC_KEYS.configurationHead];
      if (!isHead(published) || published.revisionId !== revisionId)
        throw new ConfigurationStorageError("SYNC_WRITE", "Published Sync head could not be verified");
      const verifiedShards = await sync.get(encoded.head.shardKeys);
      const verified = await decodeConfigurationRevision(encoded.head, verifiedShards);
      await writeShadow(shadowFor(verified.configuration, revisionId, encoded.head.checksum, now()));
      await updateRuntime({
        lastAppliedSyncRevisionId: revisionId,
        pendingSyncRevision: undefined,
        lastSyncInvalid: false
      });
      configuration = verified.configuration;
      activeRevisionId = revisionId;
      if (
        previousHead &&
        !rolledOver &&
        previousHead.revisionId !== revisionId &&
        shadowMatchesHead(previousShadow, previousHead)
      ) {
        const currentHead = await sync.get(SYNC_KEYS.configurationHead);
        const current = currentHead[SYNC_KEYS.configurationHead];
        if (isHead(current) && current.revisionId === revisionId) {
          try {
            await sync.remove(previousHead.shardKeys);
          } catch {
            // Obsolete shard cleanup is best effort after the new revision commits.
          }
        }
      }
    } catch (error) {
      if (error instanceof ConfigurationStorageError) throw error;
      throw mapSyncWriteError(error);
    }
  }

  async function loadLegacyOrDefault(): Promise<Configuration> {
    if (chromeStorage) {
      const legacyStored = await areas!.local.get(STORAGE_KEYS.legacyConfiguration);
      if (legacyStored[STORAGE_KEYS.legacyConfiguration] !== undefined) {
        let migrated: Configuration | undefined;
        try {
          migrated = validateConfiguration(legacyStored[STORAGE_KEYS.legacyConfiguration]);
        } catch {
          migrated = undefined;
        }
        if (migrated) {
          try {
            await saveSync(migrated);
            await areas!.local.remove(STORAGE_KEYS.legacyConfiguration);
            return configuration;
          } catch {
            configuration = migrated;
            return configuration;
          }
        }
      }
      const fallback = validateConfiguration(createDefault());
      await saveSync(fallback);
      return configuration;
    }
    const stored = await legacy!.get(STORAGE_KEYS.legacyConfiguration);
    const existing = stored[STORAGE_KEYS.legacyConfiguration];
    if (existing !== undefined) {
      try {
        const normalized = validateConfiguration(existing);
        if (JSON.stringify(normalized) !== JSON.stringify(existing))
          await saveLegacy(normalized);
        configuration = normalized;
        return configuration;
      } catch {
        /* replace invalid bootstrap state */
      }
    }
    configuration = validateConfiguration(createDefault());
    await saveLegacy(configuration);
    return configuration;
  }

  async function loadOrCreate(): Promise<Configuration> {
    if (!chromeStorage) {
      return loadLegacyOrDefault();
    }
    const shadow = await readShadow();
    const candidate = await readCandidate();
    if (candidate.kind === "valid") {
      const currentRuntime = await readRuntime();
      if (shadowMatchesHead(shadow, candidate.head)) {
        configuration = candidate.configuration;
        activeRevisionId = candidate.head.revisionId;
        return configuration;
      }
      if (currentRuntime.lastLocallyAuthoredSyncRevisionId === candidate.head.revisionId) {
        await writeShadow(shadowFor(candidate.configuration, candidate.head.revisionId, candidate.head.checksum, now()));
        await updateRuntime({
          lastAppliedSyncRevisionId: candidate.head.revisionId,
          pendingSyncRevision: undefined,
          lastSyncInvalid: false
        });
        configuration = candidate.configuration;
        activeRevisionId = candidate.head.revisionId;
        return configuration;
      }
      if (candidate.migrated) {
        await saveSync(candidate.configuration);
        return configuration;
      }
      await writeShadow(shadowFor(candidate.configuration, candidate.head.revisionId, candidate.head.checksum, now()));
      await updateRuntime({
        lastAppliedSyncRevisionId: candidate.head.revisionId,
        pendingSyncRevision: undefined,
        lastSyncInvalid: false
      });
      configuration = candidate.configuration;
      activeRevisionId = candidate.head.revisionId;
      return configuration;
    }
    if (candidate.kind === "invalid") {
      await recordInvalidSyncRuntime({
        head: candidate.head,
        reason: candidate.reason
      });
      if (shadow) {
        configuration = shadow.configuration;
        activeRevisionId = shadow.revisionId;
      }
      return configuration;
    }
    if (shadow) {
      configuration = shadow.configuration;
      activeRevisionId = shadow.revisionId;
      return configuration;
    }
    return loadLegacyOrDefault();
  }

  async function applySyncChange(changedKeys: readonly string[] = []): Promise<SyncChangeResult> {
    if (!chromeStorage) return { kind: "ignored", configuration };
    if (
      changedKeys.length > 0 &&
      !changedKeys.some(
        (key) => key === SYNC_KEYS.configurationHead || key.startsWith(SYNC_KEYS.revisionPrefix)
      )
    )
      return { kind: "ignored", configuration };
    const candidate = await readCandidate();
    if (candidate.kind === "missing") return { kind: "ignored", configuration };
    if (candidate.kind === "invalid") {
      await recordInvalidSyncRuntime({
        head: candidate.head,
        reason: candidate.reason
      });
      if (isIncompleteSyncReason(candidate.reason))
        return { kind: "pending", configuration, revisionId: candidate.head?.revisionId };
      return { kind: "invalid", configuration, reason: candidate.reason };
    }
    const runtime = await readRuntime();
    const controllerApplied =
      runtime.controllerAppliedSyncRevisionId === candidate.head.revisionId;
    if (activeRevisionId === candidate.head.revisionId && controllerApplied)
      return { kind: "already-applied", configuration, revisionId: candidate.head.revisionId };
    if (candidate.migrated) {
      await saveSync(candidate.configuration);
      return { kind: "applied", configuration, revisionId: candidate.head.revisionId };
    }
    await writeShadow(shadowFor(candidate.configuration, candidate.head.revisionId, candidate.head.checksum, now()));
    await updateRuntime({
      lastAppliedSyncRevisionId: candidate.head.revisionId,
      pendingSyncRevision: undefined,
      lastSyncInvalid: false
    });
    configuration = candidate.configuration;
    activeRevisionId = candidate.head.revisionId;
    return { kind: "applied", configuration, revisionId: candidate.head.revisionId };
  }

  return {
    async loadOrCreate() {
      const operation = saveQueue.then(loadOrCreate);
      saveQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async save(next) {
      const operation = saveQueue.then(async () => {
        await saveSync(next);
      });
      saveQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async applySyncChange(changedKeys) {
      const operation = saveQueue.then(() => applySyncChange(changedKeys));
      saveQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async markControllerRevisionApplied(revisionId) {
      const operation = saveQueue.then(async () => {
        await updateRuntime({
          controllerAppliedSyncRevisionId: revisionId,
          pendingSyncRevision: undefined,
          lastSyncInvalid: false
        });
      });
      saveQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    getConfiguration() {
      return configuration;
    }
  };
}

export { ConfigurationRevisionError };
