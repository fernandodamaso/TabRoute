import { describe, expect, it } from "vitest";
import { scanChromeMutations } from "../../scripts/check-chrome-mutations";

describe("check-chrome-mutations", () => {
  it("flags direct tab mutations outside liveChromePort", () => {
    const violations = scanChromeMutations();
    expect(violations).toEqual([]);
  });
});
