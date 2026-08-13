import type {
  BrowserSessionId,
  ChromeAssociation,
  RuntimeSession
} from "../domain/types";
import { parseRuntimeSession } from "./runtimeSession";

export interface SessionRepository {
  loadSession(): Promise<RuntimeSession>;
  saveSession(session: RuntimeSession): Promise<void>;
  loadAssociations(): Promise<readonly ChromeAssociation[]>;
  saveAssociations(associations: readonly ChromeAssociation[]): Promise<void>;
  loadRuntime(): Promise<Record<string, unknown>>;
  updateRuntime(patch: Record<string, unknown>): Promise<void>;
}

export interface SessionStoragePort {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

const SESSION_KEY = "runtime:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedBrowserSessionId(
  value: Record<string, unknown>
): BrowserSessionId | undefined {
  return typeof value.browserSessionId === "string" &&
    value.browserSessionId.length > 0
    ? (value.browserSessionId as BrowserSessionId)
    : undefined;
}

function mintBrowserSessionId(): BrowserSessionId {
  return crypto.randomUUID() as BrowserSessionId;
}

function recordIsAbsent(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

const RUNTIME_SESSION_KEYS = [
  "schemaVersion",
  "browserSessionId",
  "nextObservationOrdinal",
  "tabObservations",
  "manualOverrides",
  "intentionallyClosedGroupIds",
  "operationGuards",
  "pendingGroupRemovals",
  "lastFocusedNormalWindowId",
  "associations"
] as const satisfies readonly (keyof RuntimeSession)[];

function sessionFromStore(current: Record<string, unknown>): RuntimeSession {
  const fallback = storedBrowserSessionId(current) ?? mintBrowserSessionId();
  return parseRuntimeSession(
    recordIsAbsent(current) ? undefined : current,
    fallback
  );
}

function toStoredSession(session: RuntimeSession): Record<string, unknown> {
  const stored: Record<string, unknown> = {
    schemaVersion: session.schemaVersion,
    browserSessionId: session.browserSessionId,
    nextObservationOrdinal: session.nextObservationOrdinal,
    tabObservations: session.tabObservations,
    manualOverrides: session.manualOverrides,
    intentionallyClosedGroupIds: session.intentionallyClosedGroupIds,
    operationGuards: session.operationGuards,
    pendingGroupRemovals: session.pendingGroupRemovals,
    associations: session.associations
  };
  if (session.lastFocusedNormalWindowId !== undefined) {
    stored.lastFocusedNormalWindowId = session.lastFocusedNormalWindowId;
  }
  return stored;
}

function mergeStoredSession(
  current: Record<string, unknown>,
  session: RuntimeSession
): Record<string, unknown> {
  const extra = { ...current };
  for (const key of RUNTIME_SESSION_KEYS) {
    delete extra[key];
  }
  return { ...extra, ...toStoredSession(session) };
}

export function createMemorySessionRepository(
  initial: readonly ChromeAssociation[] = []
): SessionRepository {
  let value: Record<string, unknown> = { associations: [...initial] };

  async function loadSession() {
    const session = sessionFromStore(value);
    if (!storedBrowserSessionId(value)) {
      value = mergeStoredSession(value, session);
    }
    return session;
  }

  async function saveSession(session: RuntimeSession) {
    value = mergeStoredSession(value, session);
  }

  return {
    loadSession,
    saveSession,
    async loadAssociations() {
      return (await loadSession()).associations;
    },
    async saveAssociations(associations) {
      const session = await loadSession();
      await saveSession({ ...session, associations: [...associations] });
    },
    async loadRuntime() {
      return { ...value };
    },
    async updateRuntime(patch) {
      value = { ...value, ...patch };
    }
  };
}

export function createChromeSessionRepository(
  storage: SessionStoragePort
): SessionRepository {
  let queue: Promise<unknown> = Promise.resolve();

  async function readState(): Promise<Record<string, unknown>> {
    const stored = await storage.get(SESSION_KEY);
    const value = stored[SESSION_KEY];
    return isRecord(value) ? { ...value } : {};
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function loadSession() {
    return serialized(async () => {
      const current = await readState();
      const session = sessionFromStore(current);
      if (!storedBrowserSessionId(current)) {
        await storage.set({
          [SESSION_KEY]: mergeStoredSession(current, session)
        });
      }
      return session;
    });
  }

  async function saveSession(session: RuntimeSession) {
    await serialized(async () => {
      const current = await readState();
      await storage.set({
        [SESSION_KEY]: mergeStoredSession(current, session)
      });
    });
  }

  return {
    loadSession,
    saveSession,
    async loadAssociations() {
      return (await loadSession()).associations;
    },
    async saveAssociations(associations) {
      await serialized(async () => {
        const current = await readState();
        const session = sessionFromStore(current);
        await storage.set({
          [SESSION_KEY]: mergeStoredSession(current, {
            ...session,
            associations: [...associations]
          })
        });
      });
    },
    async loadRuntime() {
      return serialized(readState);
    },
    async updateRuntime(patch) {
      await serialized(async () => {
        const current = await readState();
        await storage.set({ [SESSION_KEY]: { ...current, ...patch } });
      });
    }
  };
}
