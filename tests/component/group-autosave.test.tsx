// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useGroupAutosave } from "../../src/ui/manager/groups/useGroupAutosave";

it("debounces text, saves toggles immediately, and reports Saving/Saved", async () => {
  vi.useFakeTimers();
  const save = vi.fn(async () => ({ ok: true as const }));
  const { result } = renderHook(() => useGroupAutosave({ groupId: "group-id" as never, save }));
  act(() => result.current.update({ name: "Work" }));
  expect(save).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(250); await Promise.resolve(); });
  expect(save).toHaveBeenCalledTimes(1);
  expect(result.current.status).toBe("Saved");
  act(() => result.current.update({ enabled: false }, true));
  expect(result.current.status).toBe("Saving");
  await act(async () => { await Promise.resolve(); });
  expect(save).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it("does not apply an older response over a newer local edit", async () => {
  const responses: Array<() => void> = [];
  const save = vi.fn(() => new Promise<{ ok: true }>((resolve) => responses.push(() => resolve({ ok: true }))));
  const { result } = renderHook(() => useGroupAutosave({ groupId: "group-id" as never, save }));
  act(() => result.current.update({ name: "First" }, true));
  act(() => result.current.update({ name: "Second" }, true));
  await act(async () => { responses.shift()?.(); await Promise.resolve(); });
  expect(result.current.lastAccepted).not.toEqual({ name: "First" });
  responses.shift()?.();
  await act(async () => { await Promise.resolve(); });
  expect(result.current.lastAccepted).toEqual({ name: "Second" });
});

it("keeps pending and accepted edits scoped when selection changes", async () => {
  const responses: Array<() => void> = [];
  const saves: Array<{ groupId: string; patch: Record<string, unknown> }> = [];
  const { result, rerender } = renderHook(
    ({ groupId }: { groupId: string }) => useGroupAutosave({
      groupId: groupId as never,
      save: async (patch) => {
        saves.push({ groupId, patch });
        return new Promise<{ ok: true }>((resolve) => responses.push(() => resolve({ ok: true })));
      }
    }),
    { initialProps: { groupId: "group-a" } }
  );

  act(() => result.current.update({ name: "Accepted A" }));
  rerender({ groupId: "group-b" });
  act(() => result.current.update({ name: "Edited B" }, true));

  expect(saves).toEqual([
    { groupId: "group-a", patch: { name: "Accepted A" } },
    { groupId: "group-b", patch: { name: "Edited B" } }
  ]);
  responses.shift()?.();
  await act(async () => { await Promise.resolve(); });

  expect(saves).toEqual([
    { groupId: "group-a", patch: { name: "Accepted A" } },
    { groupId: "group-b", patch: { name: "Edited B" } }
  ]);
  responses.shift()?.();
  await act(async () => { await Promise.resolve(); });

  rerender({ groupId: "group-a" });
  expect(result.current.lastAccepted).toEqual({ name: "Accepted A" });
});
