import { describe, expect, it } from "vitest";
import { createMemoryLocalRepository, createActivityEntry } from "../../src/state/localRepository";
import { appendActivityEntry, clearActivity } from "../../src/activity/activityRepository";

describe("activity undo repository", () => {
  it("appends activity without writing activity:v1 from fixtures", async () => {
    const local = createMemoryLocalRepository();
    await appendActivityEntry(
      local,
      createActivityEntry({
        action: "Closed duplicate",
        result: "success",
        affectedManagedGroupIds: [],
        affectedUrls: ["https://example.com/"],
        createdAt: 1
      })
    );
    const entries = await local.listActivity(undefined, 10);
    expect(entries).toHaveLength(1);
    await clearActivity(local);
    expect(await local.listActivity(undefined, 10)).toHaveLength(0);
  });
});
