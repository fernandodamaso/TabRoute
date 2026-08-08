import { reconstructAssociations } from "../../src/chrome/reconstructAssociations";
import { createDefaultConfiguration } from "../../src/domain/defaults";

it("reconstructs every unambiguous normal-window association and ignores shared groups", () => {
  const configuration = createDefaultConfiguration(() => "00000000-0000-4000-8000-000000000001");
  const associations = reconstructAssociations({
    windows: [
      { id: 1, focused: true, incognito: false, type: "normal" },
      { id: 2, focused: false, incognito: false, type: "normal" }
    ],
    tabs: [],
    groups: [
      { id: 12, windowId: 1, title: "Other", color: "grey", collapsed: false, shared: true },
      { id: 13, windowId: 1, title: "Other", color: "grey", collapsed: false, shared: false },
      { id: 14, windowId: 2, title: "Other", color: "grey", collapsed: false, shared: false }
    ],
    capturedAt: 1
  }, configuration, () => 2);

  expect(associations).toEqual([
    { managedGroupId: configuration.fallbackGroupId, chromeGroupId: 13, chromeWindowId: 1, observedAt: 2 },
    { managedGroupId: configuration.fallbackGroupId, chromeGroupId: 14, chromeWindowId: 2, observedAt: 2 }
  ]);
});
