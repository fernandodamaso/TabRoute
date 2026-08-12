import { describe, expect, it } from "vitest";
import { capMetadata, encodeUtf8, orderOptionalEvidence, orderTerminalRuns, rotateTextLog } from "../../scripts/workbench/artifacts";

describe("workbench artifact retention", () => {
  it("sorts terminal runs by terminalAt and then runId", () => {
    expect(orderTerminalRuns([
      { runId: "b", terminalAt: 10 }, { runId: "a", terminalAt: 10 }, { runId: "c", terminalAt: 5 }
    ])).toEqual([{ runId: "c", terminalAt: 5 }, { runId: "a", terminalAt: 10 }, { runId: "b", terminalAt: 10 }]);
  });

  it("sorts optional evidence by capturedAt, runId, and relativePath", () => {
    expect(orderOptionalEvidence([
      { runId: "b", relativePath: "z", capturedAt: 1, category: "trace" },
      { runId: "a", relativePath: "z", capturedAt: 1, category: "trace" },
      { runId: "a", relativePath: "a", capturedAt: 1, category: "trace" }
    ])).toEqual([
      { runId: "a", relativePath: "a", capturedAt: 1, category: "trace" },
      { runId: "a", relativePath: "z", capturedAt: 1, category: "trace" },
      { runId: "b", relativePath: "z", capturedAt: 1, category: "trace" }
    ]);
  });

  it("rotates text logs at five MiB without evicting required metadata", () => {
    const result = rotateTextLog(new Uint8Array(5 * 1024 * 1024 + 10), 5 * 1024 * 1024);
    expect(result.byteLength).toBe(5 * 1024 * 1024);
  });

  it("caps metadata before encoding and retains bounded fields", () => {
    const capped = capMetadata({ scenario: "x".repeat(10_000), url: "u".repeat(30_000), screenshotPaths: Array.from({ length: 600 }, (_, i) => String(i)) });
    expect(encodeUtf8(JSON.stringify(capped)).byteLength).toBeGreaterThan(0);
    expect(capped.scenario).toHaveLength(4096);
    expect(capped.url).toHaveLength(16384);
    expect(capped.screenshotPaths).toHaveLength(500);
  });
});
