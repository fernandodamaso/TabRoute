import {
  assertHistoricalSurfacesAbsent,
  assertManagerStructure,
  CANONICAL_FRAMES,
  compareCanonicalPngOnLinux,
  expect,
  openPopup,
  test
} from "./fixtures";

test("popup opens Groups at 520x600 without clipping or historical surfaces", async ({
  production
}) => {
  await openPopup(production);
  await expect(
    production.page.getByRole("heading", { name: "Groups" })
  ).toBeVisible();
  await assertManagerStructure(production.page);
  await assertHistoricalSurfacesAbsent(production.page);
  await expect(production.page.locator("[data-workbench-marker]")).toHaveCount(
    0
  );
  await expect(production.page.locator("[data-workbench-control]")).toHaveCount(
    0
  );
  const clipped = await production.page.evaluate(() => {
    const shell = document.querySelector(".manager-shell");
    if (!shell) return true;
    const rect = shell.getBoundingClientRect();
    return (
      Math.abs(rect.width - 520) > 0.5 || Math.abs(rect.height - 600) > 0.5
    );
  });
  expect(clipped).toBe(false);
  await expect(
    production.page.getByRole("heading", { name: "Persistent tabs" })
  ).toBeVisible();
  const groupsFrame = CANONICAL_FRAMES.find(
    (frame) => frame.stem === "39-2-groups"
  );
  expect(groupsFrame).toBeTruthy();
  await compareCanonicalPngOnLinux(production.page, groupsFrame!);
});
