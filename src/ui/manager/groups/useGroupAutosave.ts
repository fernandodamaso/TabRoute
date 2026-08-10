import { useCallback, useEffect, useState } from "react";
import type { ManagedGroupPatch } from "../types";

type SaveResult = { ok: boolean };

interface AutosaveEntry {
  pending: ManagedGroupPatch;
  revision: number;
  inFlight: boolean;
  timer?: ReturnType<typeof setTimeout>;
  status: "Saved" | "Saving" | "Error";
  lastAccepted: ManagedGroupPatch;
  save: (patch: ManagedGroupPatch) => Promise<SaveResult>;
  listeners: Set<() => void>;
}

const entries = new Map<string, AutosaveEntry>();

function getEntry(groupId: string, save: (patch: ManagedGroupPatch) => Promise<SaveResult>) {
  const existing = entries.get(groupId);
  if (existing) {
    existing.save = save;
    return existing;
  }
  const entry: AutosaveEntry = {
    pending: {},
    revision: 0,
    inFlight: false,
    status: "Saved",
    lastAccepted: {},
    save,
    listeners: new Set()
  };
  entries.set(groupId, entry);
  return entry;
}

function notify(entry: AutosaveEntry) {
  entry.listeners.forEach((listener) => listener());
}

function flushEntry(entry: AutosaveEntry) {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  if (entry.inFlight || Object.keys(entry.pending).length === 0) return;
  const patch = entry.pending;
  entry.pending = {};
  const requestRevision = entry.revision;
  const requestSave = entry.save;
  entry.inFlight = true;
  entry.status = "Saving";
  notify(entry);
  void requestSave(patch).then((result) => {
    entry.inFlight = false;
    if (result.ok && requestRevision === entry.revision) {
      entry.lastAccepted = patch;
      entry.status = "Saved";
    } else if (!result.ok && requestRevision === entry.revision) {
      entry.status = "Error";
    }
    notify(entry);
    flushEntry(entry);
  }).catch(() => {
    entry.inFlight = false;
    if (requestRevision === entry.revision) entry.status = "Error";
    notify(entry);
    flushEntry(entry);
  });
}

export function useGroupAutosave({ groupId: _groupId, save, debounceMs = 250 }: {
  groupId: string;
  save: (patch: ManagedGroupPatch) => Promise<SaveResult>;
  debounceMs?: number;
}) {
  const entry = getEntry(_groupId, save);
  const [, rerender] = useState(0);

  useEffect(() => {
    const listener = () => rerender((value) => value + 1);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      flushEntry(entry);
    };
  }, [entry]);

  const update = useCallback((patch: ManagedGroupPatch, immediate = false) => {
    entry.revision += 1;
    entry.pending = { ...entry.pending, ...patch };
    if (entry.timer) clearTimeout(entry.timer);
    if (immediate) flushEntry(entry);
    else entry.timer = setTimeout(() => flushEntry(entry), debounceMs);
  }, [debounceMs, entry]);

  const flush = useCallback(() => flushEntry(entry), [entry]);
  return { status: entry.status, lastAccepted: entry.lastAccepted, update, flush };
}
