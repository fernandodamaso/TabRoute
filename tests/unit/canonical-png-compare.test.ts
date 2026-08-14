import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_FRAMES_DIR,
  CANONICAL_MAX_DIFF_PIXEL_RATIO,
  comparePngBuffers
} from "../e2e/fixtures";

describe("canonical PNG buffer compare", () => {
  it("accepts an identical committed frame and rejects a distinct frame at zero tolerance", async () => {
    const groups = await readFile(
      path.join(CANONICAL_FRAMES_DIR, "39-2-groups.png")
    );
    const rules = await readFile(
      path.join(CANONICAL_FRAMES_DIR, "42-2-rules-overview.png")
    );

    expect(CANONICAL_MAX_DIFF_PIXEL_RATIO).toBe(0.02);
    expect(comparePngBuffers(groups, groups)).toEqual({ ok: true });
    expect(
      comparePngBuffers(groups, groups, CANONICAL_MAX_DIFF_PIXEL_RATIO)
    ).toEqual({ ok: true });

    const mismatch = comparePngBuffers(groups, rules, 0);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.errorMessage).toMatch(/pixels|differ/i);
    }
  });

  it("uses the committed canonical-frames directory, not Playwright snapshots", () => {
    expect(path.basename(CANONICAL_FRAMES_DIR)).toBe("canonical-frames");
    expect(CANONICAL_FRAMES_DIR.replaceAll("\\", "/")).toContain(
      "tests/e2e/canonical-frames"
    );
  });
});
