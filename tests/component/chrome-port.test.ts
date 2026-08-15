import { describe, expect, it } from "vitest";
import { createFakeChromePort } from "../fakes/fakeChromePort";

describe("fakeChromePort", () => {
  it("createTab refuses an incognito windowId", async () => {
    const fake = createFakeChromePort({
      windows: [{ id: 2, focused: true, incognito: true, type: "normal" }],
      tabs: [],
      groups: [],
      capturedAt: 1
    });
    await expect(
      fake.createTab({
        url: "https://example.com/",
        windowId: 2,
        active: false
      })
    ).rejects.toThrow(/incognito/);
  });
});
