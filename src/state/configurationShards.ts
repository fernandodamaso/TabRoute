import type { Configuration } from "../domain/types";
import { validateConfiguration } from "../domain/schemas";
import { SYNC_KEYS, SYNC_LIMITS } from "./keys";

export interface ConfigurationSyncHead {
  schemaVersion: 1;
  revisionId: string;
  shardKeys: string[];
  shardCount: number;
  checksum: string;
  updatedAt: number;
}

export interface ConfigurationSyncShard {
  schemaVersion: 1;
  revisionId: string;
  index: number;
  count: number;
  payload: string;
}

export interface ConfigurationShadow {
  schemaVersion: 1;
  revisionId: string;
  checksum: string;
  configuration: Configuration;
  updatedAt: number;
}

export class ConfigurationRevisionError extends Error {
  readonly code = "SYNC_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationRevisionError";
  }
}

const encoder = new TextEncoder();

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortCanonical(nested)])
    );
  }
  return value;
}

export function canonicalConfigurationJson(configuration: Configuration): string {
  return JSON.stringify(sortCanonical(validateConfiguration(configuration)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function splitUnicode(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function measuredBytes(key: string, value: unknown): number {
  return encoder.encode(key).byteLength + encoder.encode(JSON.stringify(value)).byteLength;
}

export function configurationShardKey(revisionId: string, index: number): string {
  return `${SYNC_KEYS.revisionPrefix}${revisionId}:${index}`;
}

export async function encodeConfigurationRevision(
  configuration: Configuration,
  revisionId = crypto.randomUUID(),
  updatedAt = Date.now()
): Promise<{
  head: ConfigurationSyncHead;
  shards: Record<string, ConfigurationSyncShard>;
  configuration: Configuration;
  canonicalJson: string;
}> {
  const normalized = validateConfiguration(configuration);
  const canonicalJson = canonicalConfigurationJson(normalized);
  const chunks = splitUnicode(canonicalJson, 7000);
  const shards: Record<string, ConfigurationSyncShard> = {};
  const shardKeys = chunks.map((_, index) => configurationShardKey(revisionId, index));
  const shardCount = chunks.length;

  chunks.forEach((payload, index) => {
    const shard: ConfigurationSyncShard = {
      schemaVersion: 1,
      revisionId,
      index,
      count: shardCount,
      payload
    };
    const key = shardKeys[index]!;
    if (measuredBytes(key, shard) > SYNC_LIMITS.maxItemBytes)
      throw new ConfigurationRevisionError(`Sync shard exceeds ${SYNC_LIMITS.maxItemBytes} bytes`);
    shards[key] = shard;
  });

  const head: ConfigurationSyncHead = {
    schemaVersion: 1,
    revisionId,
    shardKeys,
    shardCount,
    checksum: await sha256(canonicalJson),
    updatedAt
  };
  if (measuredBytes(SYNC_KEYS.configurationHead, head) > SYNC_LIMITS.maxItemBytes)
    throw new ConfigurationRevisionError(`Sync head exceeds ${SYNC_LIMITS.maxItemBytes} bytes`);
  return { head, shards, configuration: normalized, canonicalJson };
}

function asShardEntries(
  items: Record<string, unknown> | readonly ConfigurationSyncShard[]
): readonly [string, unknown][] {
  return Array.isArray(items)
    ? items.map((item) => [configurationShardKey(item.revisionId, item.index), item])
    : Object.entries(items);
}

export async function decodeConfigurationRevision(
  head: ConfigurationSyncHead,
  items: Record<string, unknown> | readonly ConfigurationSyncShard[]
): Promise<{ configuration: Configuration; migrated: boolean; canonicalJson: string }> {
  if (
    !hasExactKeys(head, [
      "schemaVersion",
      "revisionId",
      "shardKeys",
      "shardCount",
      "checksum",
      "updatedAt"
    ]) ||
    head?.schemaVersion !== 1 ||
    typeof head.revisionId !== "string" ||
    !Array.isArray(head.shardKeys) ||
    head.shardKeys.length !== head.shardCount ||
    head.shardCount < 1 ||
    typeof head.checksum !== "string"
  )
    throw new ConfigurationRevisionError("Sync head is malformed");

  const entries = new Map(asShardEntries(items));
  const shards = head.shardKeys.map((key, index) => {
    if (
      key !== configurationShardKey(head.revisionId, index) ||
      !/^config:v1:revision:[^:]+:\d+$/.test(key)
    )
      throw new ConfigurationRevisionError("Sync head contains an invalid shard key");
    const shard = entries.get(key) as ConfigurationSyncShard | undefined;
    if (!shard) throw new ConfigurationRevisionError("Sync revision is incomplete");
    if (
      !hasExactKeys(shard, [
        "schemaVersion",
        "revisionId",
        "index",
        "count",
        "payload"
      ])
    )
      throw new ConfigurationRevisionError("Sync revision shard has unknown fields");
    if (
      shard.schemaVersion !== 1 ||
      shard.revisionId !== head.revisionId ||
      shard.index !== index ||
      shard.count !== head.shardCount ||
      typeof shard.payload !== "string"
    )
      throw new ConfigurationRevisionError("Sync revision shards are mixed or malformed");
    if (measuredBytes(key, shard) > SYNC_LIMITS.hardItemBytes)
      throw new ConfigurationRevisionError("Sync revision shard exceeds Chrome quota");
    return shard;
  });
  const serialized = shards.map((shard) => shard.payload).join("");
  if ((await sha256(serialized)) !== head.checksum)
    throw new ConfigurationRevisionError("Sync revision checksum does not match");
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new ConfigurationRevisionError("Sync revision is not valid JSON");
  }
  const configuration = validateConfiguration(raw);
  return {
    configuration,
    migrated:
      !!raw &&
      typeof raw === "object" &&
      Array.isArray((raw as { groups?: unknown }).groups) &&
      (raw as { groups: Array<Record<string, unknown>> }).groups.some(
        (group) => !Object.prototype.hasOwnProperty.call(group, "enabled")
      ),
    canonicalJson: canonicalConfigurationJson(configuration)
  };
}
