import { describe, expect, it, vi } from "vitest";
import {
  classifyMutationError,
  executeWithRetry
} from "../../src/actions/retryPolicy";

describe("classifyMutationError", () => {
  it("classifies drag collision errors as transient-drag", () => {
    expect(
      classifyMutationError(new Error("Tabs cannot be edited right now"))
    ).toBe("transient-drag");
    expect(
      classifyMutationError(new Error("tabs CANNOT be edited RIGHT NOW"))
    ).toBe("transient-drag");
  });

  it("classifies permission errors without retry", () => {
    expect(classifyMutationError(new Error("permission denied"))).toBe(
      "permission"
    );
  });

  it("classifies missing tab errors as gone", () => {
    expect(classifyMutationError(new Error("No tab with id 7"))).toBe("gone");
  });
});

describe("executeWithRetry", () => {
  it("retries transient drag errors with 50ms then 150ms delays", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("Tabs cannot be edited right now"))
      .mockRejectedValueOnce(new Error("Tabs cannot be edited right now"))
      .mockResolvedValueOnce("ok");
    const refresh = vi.fn().mockResolvedValue(undefined);
    const delays: number[] = [];
    const delay = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    const result = await executeWithRetry(operation, refresh, delay);

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([50, 150]);
  });

  it("stops after three failures", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new Error("Tabs cannot be edited right now"));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(executeWithRetry(operation, refresh, delay)).rejects.toThrow(
      "Tabs cannot be edited right now"
    );
    expect(operation).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("never retries permission errors", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("permission denied"));
    const refresh = vi.fn();
    const delay = vi.fn();

    await expect(executeWithRetry(operation, refresh, delay)).rejects.toThrow(
      "permission denied"
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("recovers a gone mutation when refreshed state is already satisfied", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("No tab with id 7"));
    const refresh = vi.fn().mockResolvedValue({ recovered: true });
    const shouldAbort = vi.fn().mockReturnValue("satisfied" as const);
    const recovered = vi.fn().mockReturnValue("recovered");

    await expect(
      executeWithRetry(
        operation,
        refresh,
        vi.fn().mockResolvedValue(undefined),
        shouldAbort,
        undefined,
        recovered
      )
    ).resolves.toBe("recovered");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});
