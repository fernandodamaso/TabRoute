import { describe, expect, it } from "vitest";
import { isLeaseReapable, type LeaseLiveness } from "../../scripts/workbench/leases";

describe("workbench lease lifecycle", () => {
  it("reaps an old lease only when the process is dead", () => {
    const lease = { runId: "run-1", pid: 42, startedAt: "2026-01-01T00:00:00.000Z", heartbeat: "2026-01-01T00:00:00.000Z", profilePath: "C:/Temp/profile", status: "active" as const };
    expect(isLeaseReapable(lease, new Date("2026-01-01T00:03:00.001Z"), { kind: "dead" })).toBe(true);
    expect(isLeaseReapable(lease, new Date("2026-01-01T00:03:00.001Z"), { kind: "alive" })).toBe(false);
  });

  it("uses the conservative ten-minute rule when liveness is unavailable", () => {
    const lease = { runId: "run-1", pid: 42, startedAt: "2026-01-01T00:00:00.000Z", heartbeat: "2026-01-01T00:00:00.000Z", profilePath: "C:/Temp/profile", status: "active" as const };
    const unavailable: LeaseLiveness = { kind: "unavailable" };
    expect(isLeaseReapable(lease, new Date("2026-01-01T00:09:59.999Z"), unavailable)).toBe(false);
    expect(isLeaseReapable(lease, new Date("2026-01-01T00:10:00.001Z"), unavailable)).toBe(true);
  });
});
