import { readFile } from "node:fs/promises";
import { join } from "node:path";

it("registers full Chrome lifecycle listeners in background", async () => {
  const source = await readFile(
    join(process.cwd(), "entrypoints/background.ts"),
    "utf8"
  );
  expect(source).toContain("tabs.onReplaced");
  expect(source).toContain("tabs.onActivated");
  expect(source).toContain("tabGroups.onRemoved");
  expect(source).toContain("windows.onFocusChanged");
  expect(source).toContain("WINDOW_ID_NONE");
  expect(source).toContain("onWorkerWake");
  expect(source).not.toContain("onSuspend");
});
