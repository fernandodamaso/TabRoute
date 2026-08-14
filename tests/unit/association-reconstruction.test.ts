import { reconstructAssociations } from "../../src/chrome/reconstructAssociations";
import { createDefaultConfiguration } from "../../src/domain/defaults";

it("reconstructs every unambiguous normal-window association and ignores shared groups", () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const associations = reconstructAssociations(
    {
      windows: [
        { id: 1, focused: true, incognito: false, type: "normal" },
        { id: 2, focused: false, incognito: false, type: "normal" }
      ],
      tabs: [
        {
          id: 21,
          windowId: 1,
          index: 0,
          chromeGroupId: 13,
          url: "https://a.example/",
          title: "A",
          pinned: false,
          active: true,
          incognito: false,
          lastAccessed: 1
        }
      ],
      groups: [
        {
          id: 12,
          windowId: 1,
          title: "Other",
          color: "grey",
          collapsed: false,
          shared: true
        },
        {
          id: 13,
          windowId: 1,
          title: "Other",
          color: "grey",
          collapsed: false,
          shared: false
        },
        {
          id: 14,
          windowId: 2,
          title: "Other",
          color: "grey",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    },
    configuration,
    () => 2
  );

  expect(associations).toEqual([
    {
      managedGroupId: configuration.fallbackGroupId,
      chromeGroupId: 13,
      chromeWindowId: 1,
      observedTitle: "Other",
      observedMemberUrls: ["https://a.example/"],
      observedAt: 2
    },
    {
      managedGroupId: configuration.fallbackGroupId,
      chromeGroupId: 14,
      chromeWindowId: 2,
      observedTitle: "Other",
      observedMemberUrls: [],
      observedAt: 2
    }
  ]);
});
it("produces no association when two managed groups claim the same rendered title / native group", () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  // Add a second managed group with the exact same name "Other"
  configuration.groups.push({
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000002" as never,
    name: "Other",
    color: "grey",
    isFallback: false,
    enabled: true,
    isPersistent: false,
    defaultOrder: 1,
    defaultCollapsed: false,
    createdAt: 1,
    updatedAt: 1
  });

  const associations = reconstructAssociations(
    {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [
        {
          id: 99,
          windowId: 1,
          title: "Other",
          color: "grey",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    },
    configuration,
    () => 10
  );

  expect(associations).toHaveLength(0);
});

it("handles two unambiguous managed groups correctly", () => {
  const configuration = createDefaultConfiguration(
    () => "00000000-0000-4000-8000-000000000001"
  );
  const secondId = "00000000-0000-4000-8000-000000000002" as never;
  configuration.groups.push({
    schemaVersion: 1,
    id: secondId,
    name: "Work",
    color: "blue",
    isFallback: false,
    enabled: true,
    isPersistent: false,
    defaultOrder: 1,
    defaultCollapsed: false,
    createdAt: 1,
    updatedAt: 1
  });

  const associations = reconstructAssociations(
    {
      windows: [{ id: 1, focused: true, incognito: false, type: "normal" }],
      tabs: [],
      groups: [
        {
          id: 10,
          windowId: 1,
          title: "Other",
          color: "grey",
          collapsed: false,
          shared: false
        },
        {
          id: 20,
          windowId: 1,
          title: "Work",
          color: "blue",
          collapsed: false,
          shared: false
        }
      ],
      capturedAt: 1
    },
    configuration,
    () => 5
  );

  expect(associations).toHaveLength(2);
  expect(associations.map((a) => a.managedGroupId)).toEqual([
    configuration.fallbackGroupId,
    secondId
  ]);
});
