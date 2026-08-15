import {
  assertCanonicalEvidencePresent,
  assertFrameContract,
  assertHistoricalSurfacesAbsent,
  assertManagerStructure,
  CANONICAL_FRAMES,
  ensureSavedRule,
  expect,
  openOptions,
  openPopup,
  primaryNavButton,
  test
} from "./fixtures";

const updateFrames = process.env.TABROUTE_UPDATE_CANONICAL_FRAMES === "1";

test("settings round-trips keep Settings aria-current and reject historical surfaces", async ({
  production
}) => {
  await openOptions(production, "settings");
  await expect(
    production.page.getByRole("heading", { name: "Settings" })
  ).toBeVisible();
  await expect(primaryNavButton(production.page, "Settings")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await assertManagerStructure(production.page);
  await assertHistoricalSurfacesAbsent(production.page);

  await production.page.getByRole("button", { name: "Snapshots" }).click();
  await expect(
    production.page.getByRole("heading", { name: "Snapshots" })
  ).toBeVisible();
  await expect(primaryNavButton(production.page, "Settings")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(
    production.page.getByRole("button", { name: "Back to Settings" })
  ).toBeVisible();

  await production.page
    .getByRole("button", { name: "Back to Settings" })
    .click();
  await expect(
    production.page.getByRole("heading", { name: "Settings" })
  ).toBeVisible();

  await production.page.getByRole("button", { name: "Diagnostics" }).click();
  await expect(
    production.page.getByRole("heading", { name: "Diagnostics" })
  ).toBeVisible();
  await expect(primaryNavButton(production.page, "Settings")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await production.page
    .getByRole("button", { name: "Back to Settings" })
    .click();
  await expect(
    production.page.getByRole("heading", { name: "Settings" })
  ).toBeVisible();
});

test("canonical frames capture structural evidence for all ten nodes", async ({
  production
}) => {
  const page = production.page;
  await openPopup(production);
  await assertHistoricalSurfacesAbsent(page);

  const byStem = Object.fromEntries(
    CANONICAL_FRAMES.map((frame) => [frame.stem, frame])
  );

  await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Persistent tabs" })
  ).toBeVisible();
  await assertFrameContract(page, byStem["39-2-groups"]!, updateFrames);

  await primaryNavButton(page, "Rules").click();
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
  await assertFrameContract(page, byStem["42-2-rules-overview"]!, updateFrames);

  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByRole("heading", { name: "New rule" })).toBeVisible();
  await assertFrameContract(page, byStem["42-3-rule-editor"]!, updateFrames);

  await page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "IF", exact: true }) })
    .getByRole("textbox", { name: "Condition value 1" })
    .fill("example.com");
  await page.getByRole("button", { name: "Add condition" }).click();
  await page.getByRole("button", { name: "Add exception" }).click();
  await expect(
    page.getByRole("heading", { name: "IF", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "AND", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "NOT", exact: true })
  ).toBeVisible();
  await assertFrameContract(
    page,
    byStem["42-4-expanded-editor"]!,
    updateFrames
  );

  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();

  const actions = page.getByRole("button", { name: /Rule actions/ }).first();
  await actions.click();
  await expect(page.getByRole("menu", { name: "Rule actions" })).toBeVisible();
  await assertFrameContract(
    page,
    byStem["90-312-rule-actions-menu"]!,
    updateFrames
  );

  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete rule?" });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).toBeTruthy();
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(520.5);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(600.5);
  await assertFrameContract(
    page,
    byStem["91-348-delete-confirmation"]!,
    updateFrames
  );
  await page.getByRole("button", { name: "Cancel" }).click();

  await primaryNavButton(page, "Activity").click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByPlaceholder("Search")).toBeVisible();
  await assertFrameContract(page, byStem["42-6-activity"]!, updateFrames);

  await primaryNavButton(page, "Settings").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Restore persistent groups")).toBeVisible();
  await assertFrameContract(page, byStem["214-1303-settings"]!, updateFrames);

  await page.getByRole("button", { name: "Snapshots" }).click();
  await expect(page.getByRole("heading", { name: "Snapshots" })).toBeVisible();
  await expect(primaryNavButton(page, "Settings")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await assertFrameContract(page, byStem["42-8-snapshots"]!, updateFrames);
  await page.getByRole("button", { name: "Back to Settings" }).click();

  await page.getByRole("button", { name: "Diagnostics" }).click();
  await expect(
    page.getByRole("heading", { name: "Diagnostics" })
  ).toBeVisible();
  await expect(primaryNavButton(page, "Settings")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await assertFrameContract(page, byStem["42-11-diagnostics"]!, updateFrames);

  await assertCanonicalEvidencePresent();
});

test("options hash opens settings subpanels with shell contract", async ({
  production
}) => {
  await openOptions(production, "settings/snapshots");
  await expect(
    production.page.getByRole("heading", { name: "Snapshots" })
  ).toBeVisible();
  await expect(primaryNavButton(production.page, "Settings")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await assertManagerStructure(production.page);

  await production.page.setViewportSize({ width: 520, height: 600 });
  await production.page.goto(
    `chrome-extension://${production.extensionId}/options.html?panel=diagnostics#settings/diagnostics`
  );
  await expect(
    production.page.getByRole("heading", { name: "Diagnostics" })
  ).toBeVisible({ timeout: 15_000 });
  await expect(primaryNavButton(production.page, "Settings")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(production.page).toHaveURL(/#settings\/diagnostics$/);
  await assertManagerStructure(production.page);
});

test("standalone persistent tabs hash does not become a primary route", async ({
  production
}) => {
  await openOptions(production, "persistent");
  await expect(
    production.page.getByRole("heading", { name: "Groups" })
  ).toBeVisible();
  await assertHistoricalSurfacesAbsent(production.page);
  await ensureSavedRule(production.page);
});
