import { createUuid } from "../domain/ids";
import type {
  ActivityEntry,
  ShutdownCheckpoint,
  Snapshot,
  StorageDiagnostics,
  UndoRecord,
  UUID,
  WindowOwnershipDescriptor
} from "../domain/types";
import { STORAGE_KEYS, SYNC_LIMITS, type StorageAreaPort } from "./keys";
import { storageItemBytes } from "./configurationShards";

export const LOCAL_SOFT_BUDGET_BYTES = 9_437_184;

export interface LocalRepository {
  listSnapshots(): Promise<Snapshot[]>;
  getSnapshot(id: UUID): Promise<Snapshot | null>;
  saveSnapshot(
    snapshot: Snapshot
  ): Promise<
    { ok: true } | { ok: false; code: "SNAPSHOT_LIMIT" | "LOCAL_WRITE" }
  >;
  deleteSnapshot(id: UUID): Promise<void>;
  loadShutdownCheckpoint(): Promise<ShutdownCheckpoint | null>;
  saveShutdownCheckpoint(
    value: ShutdownCheckpoint
  ): Promise<
    { ok: true } | { ok: false; code: "CHECKPOINT_CAPACITY" | "LOCAL_WRITE" }
  >;
  appendActivity(entry: ActivityEntry): Promise<void>;
  listActivity(
    before: number | undefined,
    limit: number
  ): Promise<ActivityEntry[]>;
  clearActivity(): Promise<void>;
  putUndo(record: UndoRecord): Promise<void>;
  getUndo(id: UUID): Promise<UndoRecord | null>;
  listUndo(): Promise<UndoRecord[]>;
  deleteUndo(id: UUID): Promise<void>;
  loadWindowOwnership(): Promise<Record<UUID, WindowOwnershipDescriptor>>;
  saveWindowOwnership(
    value: Record<UUID, WindowOwnershipDescriptor>
  ): Promise<void>;
  getStorageDiagnostics(): Promise<StorageDiagnostics>;
}

interface LocalBags {
  snapshots: Snapshot[];
  checkpoint: ShutdownCheckpoint | null;
  activity: ActivityEntry[];
  undo: Record<string, UndoRecord>;
  ownership: Record<UUID, WindowOwnershipDescriptor>;
}

function emptyBags(): LocalBags {
  return {
    snapshots: [],
    checkpoint: null,
    activity: [],
    undo: {},
    ownership: {}
  };
}

function estimateBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createMemoryLocalRepository(
  initial: Partial<LocalBags> = {}
): LocalRepository & { bags: LocalBags } {
  const bags: LocalBags = { ...emptyBags(), ...initial };

  async function pruneForCheckpoint(incomingBytes: number, now: number) {
    const expiredUndo = Object.values(bags.undo).filter(
      (record) => record.expiresAt <= now
    );
    for (const record of expiredUndo) {
      for (const key of Object.keys(bags.undo)) {
        if (bags.undo[key]?.id === record.id) delete bags.undo[key];
      }
    }

    let total =
      estimateBytes(bags.snapshots) +
      estimateBytes(bags.activity) +
      estimateBytes(bags.undo) +
      estimateBytes(bags.ownership) +
      incomingBytes;

    const automatic = [...bags.snapshots]
      .filter((snapshot) => snapshot.kind === "automatic")
      .sort((left, right) => left.createdAt - right.createdAt);
    while (total > LOCAL_SOFT_BUDGET_BYTES && automatic.length > 0) {
      const oldest = automatic.shift()!;
      bags.snapshots = bags.snapshots.filter(
        (snapshot) => snapshot.id !== oldest.id
      );
      total =
        estimateBytes(bags.snapshots) +
        estimateBytes(bags.activity) +
        estimateBytes(bags.undo) +
        estimateBytes(bags.ownership) +
        incomingBytes;
    }

    const sortedActivity = [...bags.activity].sort(
      (left, right) => left.createdAt - right.createdAt
    );
    while (total > LOCAL_SOFT_BUDGET_BYTES && sortedActivity.length > 0) {
      const oldest = sortedActivity.shift()!;
      bags.activity = bags.activity.filter((entry) => entry.id !== oldest.id);
      total =
        estimateBytes(bags.snapshots) +
        estimateBytes(bags.activity) +
        estimateBytes(bags.undo) +
        estimateBytes(bags.ownership) +
        incomingBytes;
    }
  }

  return {
    bags,
    async listSnapshots() {
      return [...bags.snapshots];
    },
    async getSnapshot(id) {
      return bags.snapshots.find((snapshot) => snapshot.id === id) ?? null;
    },
    async saveSnapshot(snapshot) {
      let snapshots = [...bags.snapshots];
      const isUpdate = snapshots.some(
        (candidate) => candidate.id === snapshot.id
      );
      if (snapshot.kind !== "checkpoint" && !isUpdate) {
        const namedAndAutomatic = snapshots.filter(
          (candidate) => candidate.kind !== "checkpoint"
        );
        if (namedAndAutomatic.length >= 50) {
          const automatic = namedAndAutomatic
            .filter((candidate) => candidate.kind === "automatic")
            .sort(
              (left, right) =>
                left.createdAt - right.createdAt ||
                left.id.localeCompare(right.id)
            );
          if (automatic.length === 0) {
            return { ok: false, code: "SNAPSHOT_LIMIT" };
          }
          const oldest = automatic[0]!;
          snapshots = snapshots.filter(
            (candidate) => candidate.id !== oldest.id
          );
        }
      }
      bags.snapshots = [
        ...snapshots.filter((candidate) => candidate.id !== snapshot.id),
        snapshot
      ];
      return { ok: true };
    },
    async deleteSnapshot(id) {
      bags.snapshots = bags.snapshots.filter((snapshot) => snapshot.id !== id);
    },
    async loadShutdownCheckpoint() {
      return bags.checkpoint;
    },
    async saveShutdownCheckpoint(value) {
      const incomingBytes = estimateBytes(value);
      await pruneForCheckpoint(incomingBytes, value.capturedAt);
      const total =
        estimateBytes(bags.snapshots) +
        estimateBytes(bags.activity) +
        estimateBytes(bags.undo) +
        estimateBytes(bags.ownership) +
        incomingBytes;
      if (total > LOCAL_SOFT_BUDGET_BYTES) {
        return { ok: false, code: "CHECKPOINT_CAPACITY" };
      }
      bags.checkpoint = value;
      return { ok: true };
    },
    async appendActivity(entry) {
      bags.activity = [entry, ...bags.activity].slice(0, 500);
    },
    async listActivity(before, limit) {
      const filtered =
        before === undefined
          ? bags.activity
          : bags.activity.filter((entry) => entry.createdAt < before);
      return filtered.slice(0, limit);
    },
    async clearActivity() {
      bags.activity = [];
    },
    async putUndo(record) {
      bags.undo[record.id] = record;
    },
    async getUndo(id) {
      return bags.undo[id] ?? null;
    },
    async listUndo() {
      return Object.values(bags.undo);
    },
    async deleteUndo(id) {
      delete bags.undo[id];
    },
    async loadWindowOwnership() {
      return { ...bags.ownership };
    },
    async saveWindowOwnership(value) {
      bags.ownership = { ...value };
    },
    async getStorageDiagnostics() {
      const localBytes =
        estimateBytes(bags.snapshots) +
        estimateBytes(bags.activity) +
        estimateBytes(bags.undo) +
        estimateBytes(bags.ownership) +
        estimateBytes(bags.checkpoint);
      return {
        syncBytes: 0,
        syncQuotaBytes: 102400,
        syncLargestItemBytes: 0,
        syncQuotaBytesPerItem: 8192,
        syncItemCount: 0,
        syncMaxItems: 512,
        localBytes,
        localSoftBudgetBytes: LOCAL_SOFT_BUDGET_BYTES,
        localQuotaBytes: 10485760,
        sessionBytes: 0,
        sessionQuotaBytes: 10485760
      };
    }
  };
}

export function createChromeLocalRepository(
  local: StorageAreaPort,
  sync: StorageAreaPort,
  session: StorageAreaPort
): LocalRepository {
  async function readBag<T>(key: string, fallback: T): Promise<T> {
    const stored = await local.get(key);
    const value = stored[key];
    return (value as T | undefined) ?? fallback;
  }

  async function writeBag(key: string, value: unknown) {
    await local.set({ [key]: value });
  }

  const memory = createMemoryLocalRepository();
  let mutationTail = Promise.resolve();

  function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutationTail.then(operation, operation);
    mutationTail = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  return {
    listSnapshots: () =>
      serializeMutation(() =>
        readBag(STORAGE_KEYS.localSnapshots, [] as Snapshot[])
      ),
    getSnapshot: (id) =>
      serializeMutation(
        async () =>
          (await readBag(STORAGE_KEYS.localSnapshots, [] as Snapshot[])).find(
            (snapshot) => snapshot.id === id
          ) ?? null
      ),
    saveSnapshot: (snapshot) =>
      serializeMutation(async () => {
        const snapshots = await readBag(
          STORAGE_KEYS.localSnapshots,
          [] as Snapshot[]
        );
        memory.bags.snapshots = snapshots;
        const result = await memory.saveSnapshot(snapshot);
        if (result.ok) {
          await writeBag(STORAGE_KEYS.localSnapshots, memory.bags.snapshots);
        }
        return result;
      }),
    deleteSnapshot: (id) =>
      serializeMutation(async () => {
        const snapshots = await readBag(
          STORAGE_KEYS.localSnapshots,
          [] as Snapshot[]
        );
        await writeBag(
          STORAGE_KEYS.localSnapshots,
          snapshots.filter((snapshot) => snapshot.id !== id)
        );
      }),
    loadShutdownCheckpoint: () =>
      serializeMutation(() =>
        readBag(
          STORAGE_KEYS.localShutdownCheckpoint,
          null as ShutdownCheckpoint | null
        )
      ),
    saveShutdownCheckpoint: (value) =>
      serializeMutation(async () => {
        memory.bags.snapshots = await readBag(
          STORAGE_KEYS.localSnapshots,
          [] as Snapshot[]
        );
        memory.bags.checkpoint = await readBag(
          STORAGE_KEYS.localShutdownCheckpoint,
          null as ShutdownCheckpoint | null
        );
        memory.bags.activity = await readBag(
          STORAGE_KEYS.localActivity,
          [] as ActivityEntry[]
        );
        memory.bags.undo = await readBag(
          STORAGE_KEYS.localUndo,
          {} as Record<string, UndoRecord>
        );
        memory.bags.ownership = await readBag(
          STORAGE_KEYS.localWindowOwnership,
          {} as Record<UUID, WindowOwnershipDescriptor>
        );
        const result = await memory.saveShutdownCheckpoint(value);
        try {
          await writeBag(STORAGE_KEYS.localSnapshots, memory.bags.snapshots);
          await writeBag(STORAGE_KEYS.localActivity, memory.bags.activity);
          await writeBag(STORAGE_KEYS.localUndo, memory.bags.undo);
          await writeBag(
            STORAGE_KEYS.localWindowOwnership,
            memory.bags.ownership
          );
          if (result.ok)
            await writeBag(
              STORAGE_KEYS.localShutdownCheckpoint,
              memory.bags.checkpoint
            );
        } catch {
          return { ok: false, code: "LOCAL_WRITE" };
        }
        return result;
      }),
    appendActivity: (entry) =>
      serializeMutation(async () => {
        const activity = await readBag(
          STORAGE_KEYS.localActivity,
          [] as ActivityEntry[]
        );
        await writeBag(
          STORAGE_KEYS.localActivity,
          [entry, ...activity].slice(0, 500)
        );
      }),
    listActivity: (before, limit) =>
      serializeMutation(async () => {
        const activity = await readBag(
          STORAGE_KEYS.localActivity,
          [] as ActivityEntry[]
        );
        const filtered =
          before === undefined
            ? activity
            : activity.filter((entry) => entry.createdAt < before);
        return filtered.slice(0, limit);
      }),
    clearActivity: () =>
      serializeMutation(async () => {
        await writeBag(STORAGE_KEYS.localActivity, [] as ActivityEntry[]);
      }),
    putUndo: (record) =>
      serializeMutation(async () => {
        const undo = await readBag(
          STORAGE_KEYS.localUndo,
          {} as Record<string, UndoRecord>
        );
        await writeBag(STORAGE_KEYS.localUndo, {
          ...undo,
          [record.id]: record
        });
      }),
    getUndo: (id) =>
      serializeMutation(async () => {
        const undo = await readBag(
          STORAGE_KEYS.localUndo,
          {} as Record<string, UndoRecord>
        );
        return undo[id] ?? null;
      }),
    listUndo: () =>
      serializeMutation(async () => {
        const undo = await readBag(
          STORAGE_KEYS.localUndo,
          {} as Record<string, UndoRecord>
        );
        return Object.values(undo);
      }),
    deleteUndo: (id) =>
      serializeMutation(async () => {
        const undo = await readBag(
          STORAGE_KEYS.localUndo,
          {} as Record<string, UndoRecord>
        );
        const next = { ...undo };
        delete next[id];
        await writeBag(STORAGE_KEYS.localUndo, next);
      }),
    loadWindowOwnership: () =>
      serializeMutation(() =>
        readBag(
          STORAGE_KEYS.localWindowOwnership,
          {} as Record<UUID, WindowOwnershipDescriptor>
        )
      ),
    saveWindowOwnership: (value) =>
      serializeMutation(() =>
        writeBag(STORAGE_KEYS.localWindowOwnership, value)
      ),
    async getStorageDiagnostics() {
      const localBytes = (await local.getBytesInUse?.()) ?? 0;
      const sessionBytes = (await session.getBytesInUse?.()) ?? 0;
      const syncBytes = (await sync.getBytesInUse?.()) ?? 0;
      const syncData = await sync.get();
      const syncEntries = Object.entries(syncData);
      const syncItemCount = syncEntries.length;
      const syncLargestItemBytes = syncEntries.reduce(
        (max, [key, value]) => Math.max(max, storageItemBytes(key, value)),
        0
      );
      return {
        syncBytes,
        syncQuotaBytes: SYNC_LIMITS.maxTotalBytes,
        syncLargestItemBytes,
        syncQuotaBytesPerItem: SYNC_LIMITS.hardItemBytes,
        syncItemCount,
        syncMaxItems: SYNC_LIMITS.maxItems,
        localBytes,
        localSoftBudgetBytes: LOCAL_SOFT_BUDGET_BYTES,
        localQuotaBytes: 10485760,
        sessionBytes,
        sessionQuotaBytes: 10485760
      };
    }
  };
}

export function createActivityEntry(
  input: Omit<ActivityEntry, "schemaVersion" | "id">
): ActivityEntry {
  return { schemaVersion: 1, id: createUuid(), ...input };
}
