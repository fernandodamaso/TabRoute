# TabRoute Current Figma Reconciliation Implementation Plan

**Status:** Ready for review. This document is a plan only. It does not authorize implementation.

**Goal:** Reconcile the approved TabRoute v1 specification, current Linear issues, and the partial repository implementation with the canonical screens on Figma page `12 · Screens - Current`.

**Architecture:** The toolbar popup and options entry point render one shared React manager. The popup is a fixed 520 × 600 shell with a fixed header and primary navigation. Each feature owns its scrollable page body. UI code sends typed queries and commands to the background controller. The controller validates and persists configuration, then requests Chrome changes through the existing Action Engine boundary. The existing UUID identity, rule evaluator, deterministic selection, and routing controller remain in place unless focused tests expose a conflict.

**Technology:** WXT, Chrome Manifest V3, React 19, TypeScript, Zod, Vitest, Testing Library, Playwright.

## 1. Scope and non-goals

This plan covers:

- normalization of the ten canonical Figma frames to a 520 × 600 popup contract;
- direct revision of FDM-592 through FDM-603 as described below, without a new reconciliation issue;
- correction of the approved design specification and the older implementation plan;
- replacement of the popup placeholder and combined options editor with a shared manager;
- portable group enablement, group autosave, Rules overview, and a flat IF/AND/NOT editor;
- integration points for Activity, persistent tabs, Snapshots, Settings, and Diagnostics; and
- automated and real-Chrome verification.

This plan does not add:

- Quick Actions;
- rule suggestions or suggestion observation state;
- reusable Templates;
- a standalone Persistent tabs page;
- a nested or OR rule-builder UI;
- Firefox, Incognito, notifications, host permissions, analytics, or cloud services; or
- a new Linear reconciliation issue.

Historical Figma material remains available only as noncanonical reference. Implementation and release evidence must not cite deleted nodes `42:5`, `42:7`, `42:9`, `42:10`, or `36:2`. Node `20:2` may be mentioned only as historical reference.

## 2. Canonical design contract

Use these nodes from `12 · Screens - Current`:

| Node       | Contract                        |
| ---------- | ------------------------------- |
| `39:2`     | Groups master-detail            |
| `42:2`     | Rules overview                  |
| `42:3`     | Rule editor                     |
| `42:4`     | Expanded IF/AND/NOT rule editor |
| `42:6`     | Activity and Undo               |
| `42:8`     | Snapshots                       |
| `214:1303` | Global Settings                 |
| `42:11`    | Diagnostics                     |
| `90:312`   | Rule actions menu               |
| `91:348`   | Delete-rule confirmation        |

Every canonical frame must be 520 × 600. The app header occupies 52 px, primary navigation occupies 42 px, and the remaining feature viewport is 506 px high.

### Figma normalization work

Perform these changes before coding the corresponding screen:

1. Resize `39:2` to 520 × 600. Resize `39:20`, `39:21`, and `39:53` to 506 px high. Keep the group navigator fixed and set the selected-group inspector to clipped vertical scrolling. Keep Persistent tabs inside `39:53`.
2. Keep `42:2`, `42:3`, `42:4`, `42:11`, and `90:312` at 520 × 600.
3. Resize `42:6` and its body `66:144` to 600/506 px. Make the body a clipped vertical scroller.
4. Resize `42:8` and its body `66:282` to 600/506 px. Make the body a clipped vertical scroller.
5. Resize `214:1303` and its body `214:1313` to 600/506 px. Make the body a clipped vertical scroller.
6. In Settings data actions `214:1347`, add clear navigation to Snapshots and Diagnostics by reusing the existing Button component. Add a visible `Back to Settings` action to both destination screens.
7. Rename section `254:1163` from `Snapshots/Templates` to `Snapshots`.
8. Resize `91:348` and backdrop `91:421` to 520 × 600. Move confirmation dialog `228:1274` to y=470 so its 130 px height remains visible.
9. Preserve component instances, tokens, text styles, prototype reactions, and historical material. Do not recreate existing icons or components.
10. After each screen change, capture a screenshot and structural metadata. Verify the root size, fixed header/navigation, scroll body, overlay bounds, and Persistent tabs placement before moving to the next screen.

## 3. Linear reconciliation gate

Make Linear changes only after the Figma contract above is verified. Update the existing issues directly.

| Issue   | Required revision                                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDM-591 | Leave Done and unchanged.                                                                                                                                                                                       |
| FDM-592 | Keep Ready. Rewrite as the Groups/Rules rework. Cite the current nodes, 520 × 600 shell, group `enabled`, group autosave, Rules filters, flat IF/AND/NOT editor, overlays, and replacement of the partial code. |
| FDM-593 | Leave unchanged.                                                                                                                                                                                                |
| FDM-594 | Remove its relation to FDM-599. Ensure portable configuration includes `ManagedGroup.enabled`.                                                                                                                  |
| FDM-595 | Remove Quick Actions toast ownership and all FDM-600 relations. Activity is the only designed Undo surface.                                                                                                     |
| FDM-596 | Remove the standalone Persistent tabs screen. Use `39:2` for per-group management and `214:1303` for the startup switch.                                                                                        |
| FDM-597 | Keep the Snapshots manager, add Settings navigation and return behavior, and remove its FDM-600 relation.                                                                                                       |
| FDM-598 | Leave Canceled as the Templates decision record.                                                                                                                                                                |
| FDM-599 | Rename to `Rule suggestions — removed from v1`, rewrite as a decision record, cancel it, and remove all blocker relations.                                                                                      |
| FDM-600 | Rename to `Quick Actions popup — removed from v1`, rewrite as a decision record, cancel it, and remove all blocker relations.                                                                                   |
| FDM-601 | Replace popup/settings equivalence with the shared typed manager/controller command contract.                                                                                                                   |
| FDM-602 | Replace `42:10` with `214:1303`, remove suggestion requirements and FDM-599, and own navigation among Settings, Snapshots, and Diagnostics.                                                                     |
| FDM-603 | Use only the ten canonical nodes. Remove Quick Actions, suggestions, standalone Persistent tabs, Templates, stale nodes, and FDM-600.                                                                           |

The final blocker graph must be exactly:

```text
FDM-591 -> FDM-592, FDM-594
FDM-592 -> FDM-593
FDM-593 + FDM-594 -> FDM-595, FDM-596, FDM-597
FDM-592 + FDM-594 + FDM-595 + FDM-596 + FDM-597 -> FDM-602
FDM-595 + FDM-596 + FDM-597 -> FDM-601
FDM-601 + FDM-602 -> FDM-603
```

Read every modified issue back. Verify title, state, description, `blocks`, `blockedBy`, and related issues. Search all active TabRoute issue descriptions for the deleted node IDs and for active Quick Actions, suggestion, standalone Persistent tabs, or Templates requirements. Only canceled decision records may contain historical wording.

## 4. Documentation reconciliation

### Task 1: Correct the approved design specification

**Files:**

- Modify: `docs/superpowers/specs/2026-08-08-chrome-tab-manager-design.md`
- Modify: `docs/superpowers/plans/2026-08-08-tabroute.md`

**Changes:**

1. Add `enabled` to the portable `ManagedGroup` contract. State that disabled non-fallback groups are ineligible for automatic routing and persistent repair. Keep the fallback group enabled so unmatched routing remains defined.
2. Separate the rule engine representation from the visual editor. The engine may keep recursive `ConditionNode` evaluation. The v1 editor creates only one positive leaf or a top-level `all` of positive leaves, plus zero or more negative leaf exceptions.
3. Replace popup/settings language with one 520 × 600 manager popup. The toolbar opens Groups. The options entry point renders the same manager when a full extension page is needed.
4. Keep Persistent tabs inside each selected-group inspector. Keep only the global startup switch in Settings.
5. Rename Snapshots/Templates to Snapshots. Remove Templates from the v1 domain, architecture, acceptance, test, and release sections.
6. Remove Quick Actions and suggestions from v1 behavior, architecture, storage budgets, commands, tests, and acceptance.
7. Make Activity the only Undo surface.
8. Add Settings-to-Snapshots/Diagnostics navigation and explicit return paths.
9. Add a supersession note near the top of the 2026-08-08 implementation plan. Mark its Tasks 6, 17, 19, 20, and 21 UI assumptions as superseded by this plan. Do not silently rewrite completed tracer-bullet history.

**Verification:**

```powershell
rg -n "Quick Actions|suggestion|Suggestions|templates|Templates|42:5|42:7|42:9|42:10|36:2" docs/superpowers
npm run docs:chrome:validate
```

Any remaining match must be in a clearly labeled historical or superseded section.

## 5. FDM-592 implementation: Groups, Rules, and the shared manager

FDM-592 is the first code slice. Use strict red-green-refactor cycles. Do not start FDM-593 or later feature behavior while this slice is active.

### Task 2: Add portable group enablement without losing stored configuration

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/domain/defaults.ts`
- Modify: `src/domain/schemas.ts`
- Modify: `src/state/configurationRepository.ts`
- Modify: `src/rules/ruleEngine.ts`
- Modify: `tests/unit/configuration.test.ts`
- Modify: `tests/unit/groups.test.ts`
- Modify: `tests/unit/rules.test.ts`
- Modify: `tests/component/configuration-repository.test.ts`
- Modify: `tests/component/rule-controller.test.ts`

**Red tests:**

1. Default and newly created groups have `enabled: true`.
2. `updateManagedGroup` can change `enabled` without changing the UUID or fallback role.
3. A stored schema-v1 configuration that lacks `enabled` loads with `enabled: true`, keeps all UUIDs/rules, and writes back the normalized form instead of being replaced by a new default configuration.
4. A rule that targets a disabled non-fallback group is ineligible. The next eligible rule wins; otherwise routing uses the fallback group.
5. The fallback group cannot be disabled through the domain update command.

**Implementation:**

- Add `enabled: boolean` to `ManagedGroup` and to the allowed update patch.
- Use an additive schema migration/default for existing stored values. Compare parsed output with stored input and persist the normalized result once.
- Filter disabled targets in `selectRule`; do not change pure leaf evaluation or deterministic tie-breaking.
- Keep `enabled` in the portable configuration boundary so FDM-594 can sync it without a second model change.

**Focused verification:**

```powershell
npm run test -- tests/unit/configuration.test.ts tests/unit/groups.test.ts tests/unit/rules.test.ts tests/component/configuration-repository.test.ts tests/component/rule-controller.test.ts
npm run typecheck
```

### Task 3: Replace whole-document UI saving with a typed manager protocol

**Files:**

- Modify: `src/ui/messages.ts`
- Create: `src/ui/manager/types.ts`
- Create: `src/background/managerMessageRouter.ts`
- Modify: `entrypoints/background.ts`
- Create: `tests/component/manager-message-router.test.ts`
- Modify: `tests/unit/architecture.test.ts`

**Red tests:**

1. A manager query returns the validated current configuration and view metadata.
2. `updateGroup`, `createGroup`, `deleteGroup`, `saveRule`, `duplicateRule`, `deleteRule`, and rule state commands are exhaustive typed messages.
3. Every command validates IDs, drafts, and references before repository writes.
4. Invalid commands leave the last valid configuration unchanged.
5. Successful commands persist once, replace the controller configuration, return the accepted state, and request only controller-owned reconciliation.
6. UI modules cannot import repositories, the live Chrome port, or mutating Chrome APIs.

**Implementation:**

- Replace `get-configuration`/`save-configuration` as the UI editing API. A temporary read compatibility case may remain only until both entry points use the manager.
- Keep command creation of UUIDs and timestamps in the background/domain layer, not in React.
- Return structured success or field/reference errors. Do not use thrown strings as the UI contract.
- Preserve the Action Engine as the only Chrome mutation boundary.

**Focused verification:**

```powershell
npm run test -- tests/component/manager-message-router.test.ts tests/unit/architecture.test.ts
npm run typecheck
```

### Task 4: Build the shared 520 × 600 manager shell

**Files:**

- Create: `src/ui/manager/ManagerApp.tsx`
- Create: `src/ui/manager/ManagerShell.tsx`
- Create: `src/ui/manager/useManagerState.ts`
- Create: `src/ui/manager/manager.css`
- Modify: `entrypoints/popup/App.tsx`
- Modify: `entrypoints/popup/popup.css`
- Modify: `entrypoints/options/App.tsx`
- Modify: `entrypoints/options/options.css`
- Create: `tests/component/manager-shell.test.tsx`
- Create: `tests/component/manager-navigation.test.tsx`

**Red tests:**

1. The popup renders Groups first and never renders the old placeholder.
2. Header and primary navigation remain outside the page scroller.
3. Primary destinations are Groups, Rules, Activity, and Settings.
4. Route changes update the active tab, page heading, document title, and focus target.
5. The options entry point renders the same `ManagerApp`, not a second manager implementation.
6. Keyboard order follows header/navigation, page controls, then page content. Visible focus is present.

**Implementation:**

- Set `html`, `body`, and `#root` to 520 × 600 with no outer scrolling in the popup.
- Use three shell rows: 52 px header, 42 px primary navigation, and `minmax(0, 1fr)` content.
- Give each page one owned vertical scroller. Do not make the entire popup body scroll.
- Keep route state in the shared manager. Use an extension-page-safe URL/hash only when a destination must open directly from options, menus, or shortcuts.
- Reuse the Figma light tokens. Do not preserve the current unrelated dark options theme.

**Focused verification:**

```powershell
npm run test -- tests/component/manager-shell.test.tsx tests/component/manager-navigation.test.tsx
npm run typecheck
npm run build
```

### Task 5: Build Groups master-detail with autosave

**Files:**

- Create: `src/ui/manager/pages/GroupsPage.tsx`
- Create: `src/ui/manager/groups/GroupNavigator.tsx`
- Create: `src/ui/manager/groups/GroupInspector.tsx`
- Create: `src/ui/manager/groups/PersistentTabsSection.tsx`
- Create: `src/ui/manager/groups/useGroupAutosave.ts`
- Create: `tests/component/groups-page.test.tsx`
- Create: `tests/component/group-autosave.test.tsx`

**Red tests:**

1. The navigator stays fixed while only the inspector scrolls.
2. Selecting a group changes the inspector without losing navigator focus context.
3. Identity exposes name, emoji, Chrome color, and a group On toggle. Other keeps its fallback role and cannot be turned off.
4. Text edits use a short debounce or blur flush; toggles and selects save immediately.
5. Autosave has `Saving`, `Saved`, and recoverable error states. Newer local edits cannot be overwritten by an older response.
6. Group creation, reorder, and delete preserve UUID identity and the fallback invariant.
7. Routing rules and Behavior sections link to their owning editor/commands.
8. Persistent tabs render inside the inspector with loading, empty, populated, disabled-group, and error states. FDM-592 does not implement repair behavior.

**Implementation:**

- Keep one in-flight autosave per selected group and coalesce a pending patch. Flush pending text on blur and before selection/navigation changes.
- Apply server-accepted state by command revision, not response arrival order.
- Keep the navigator 156 px wide and the inspector as the only Groups body scroller at the canonical viewport.
- Use semantic controls and 44 px interaction targets where possible without changing canonical visual density.

**Focused verification:**

```powershell
npm run test -- tests/component/groups-page.test.tsx tests/component/group-autosave.test.tsx tests/unit/groups.test.ts
npm run typecheck
```

### Task 6: Build the Rules overview and overlays

**Files:**

- Create: `src/ui/manager/pages/RulesPage.tsx`
- Create: `src/ui/manager/rules/RulesOverview.tsx`
- Create: `src/ui/manager/rules/RuleActionsMenu.tsx`
- Create: `src/ui/manager/components/ConfirmationDialog.tsx`
- Create: `tests/component/rules-overview.test.tsx`
- Create: `tests/component/rule-overlays.test.tsx`

**Red tests:**

1. All/Active/Paused/Off filters use the same status calculation as the controller.
2. Each rule shows priority, summary, destination, status, enabled state, and Edit.
3. Enabling, disabling, or pausing a rule sends one typed command and refreshes accepted state.
4. Duplicate creates a new UUID in the background while preserving the source rule's editable values.
5. Delete opens the canonical confirmation. Cancel makes no command. Confirm deletes once and returns focus to the invoking menu button or a stable list target.
6. Menus and dialogs support Escape, arrow/Tab operation as appropriate, focus containment, and focus restoration.

**Focused verification:**

```powershell
npm run test -- tests/component/rules-overview.test.tsx tests/component/rule-overlays.test.tsx
npm run typecheck
```

### Task 7: Replace the recursive editor with a flat draft adapter and editor

**Files:**

- Create: `src/ui/manager/rules/flatRuleDraft.ts`
- Create: `src/ui/manager/pages/RuleEditorPage.tsx`
- Create: `src/ui/manager/rules/ConditionRow.tsx`
- Create: `tests/unit/flat-rule-draft.test.ts`
- Create: `tests/component/rule-editor.test.tsx`
- Remove after replacement: recursive editor code from `entrypoints/options/App.tsx`
- Replace: `tests/component/options-editor.test.tsx`

**Red tests:**

1. One required row maps to a positive leaf; multiple required rows map to a top-level `{ kind: "all" }` with leaf children.
2. Exception rows map to `Rule.negative` leaves.
3. Loading and saving a representable rule is lossless for UUID, priority, target, actions, enablement, and conditions.
4. The editor never creates `any` or nested condition groups.
5. Existing stored nested/OR rules continue to evaluate in the engine. The flat editor detects an unrepresentable legacy rule and blocks lossy overwrite with a clear recovery choice.
6. Add condition produces `AND`; add exception produces `NOT`; the first positive row is `IF`; one routing outcome is `THEN`.
7. Cancel discards the draft and returns to the overview. Save validates first, sends one command, and returns only after accepted state.
8. Invalid regex, pattern, references, or action combinations keep the durable rule unchanged and focus the first error.

**Implementation:**

- Keep `ConditionNode` and the pure rule engine intact.
- Introduce a UI-only flat draft type and explicit `fromRule`/`toRule` adapters.
- Do not attempt semantic flattening of arbitrary `any`/nested trees. Never silently change a legacy rule's meaning.
- Keep Rule Save/Cancel explicit. Do not reuse group autosave behavior.

**Focused verification:**

```powershell
npm run test -- tests/unit/flat-rule-draft.test.ts tests/component/rule-editor.test.tsx tests/unit/rules.test.ts tests/component/rule-controller.test.ts
npm run typecheck
npm run lint
```

### FDM-592 completion gate

Before FDM-592 can move from Ready:

- all Tasks 2-7 pass;
- `entrypoints/options/App.tsx` is only a small shared-manager adapter, not a combined editor;
- the popup opens Groups at 520 × 600;
- no Quick Actions, suggestions, Templates, or standalone Persistent tabs route exists;
- the rule engine's existing selection tests remain green; and
- a real unpacked-Chrome smoke test proves a matching rule and fallback route still use the Action Engine.

## 6. Remaining issue execution order

The following work starts only after its Linear blockers are complete.

### Task 8: FDM-594 and FDM-593 foundations

FDM-594 may proceed in parallel with FDM-592 after FDM-591. Its Sync schema must include `ManagedGroup.enabled`; missing values from older revisions default to true without new UUIDs. It must not include suggestion state or Templates.

FDM-593 starts after FDM-592. Keep its lifecycle scope unchanged. Add disabled-group coverage to event reconciliation only where target eligibility is evaluated; do not turn `enabled` into a new Chrome mutation path.

### Task 9: FDM-595, FDM-596, and FDM-597 feature pages

These three issues may proceed in parallel after FDM-593 and FDM-594.

**FDM-595 — Activity and Undo**

- Implement canonical `42:6` inside `ActivityPage`.
- Activity is the only Undo surface.
- Test search, filters, status, date grouping, optional Undo, clear-history confirmation, and body-only scrolling.
- Do not add popup toasts or FDM-600 integration.

**FDM-596 — persistent groups and tabs**

- Replace `Configuration.persistentTabs: never[]` with the validated persistent-tab model owned by this issue.
- Render and edit definitions only through `PersistentTabsSection` inside `39:2`.
- Put the global startup switch in Settings `214:1303`.
- Test empty/populated/error/disabled-group states, order, accepted patterns, startup repair, and explicit remove/open actions.
- Do not create a Persistent tabs page or navigation destination.

**FDM-597 — Snapshots**

- Implement canonical `42:8` as `SnapshotsPage`.
- Enter from Settings and provide a visible return to Settings.
- Test collapsed/expanded snapshot rows, restore/update/rename/delete, confirmation, and scroll containment.
- Do not include Templates or FDM-600 relations.

### Task 10: FDM-601 and FDM-602 integration

FDM-601 starts after FDM-595 through FDM-597. Menus and shortcuts must dispatch the same typed controller commands as the manager. They must not claim behavior is "the same as popup/settings," and they must not introduce Quick Actions commands.

FDM-602 starts after FDM-592 and FDM-594 through FDM-597.

**Files expected for FDM-602:**

- Create: `src/ui/manager/pages/SettingsPage.tsx`
- Create: `src/ui/manager/pages/SnapshotsPage.tsx`
- Create: `src/ui/manager/pages/DiagnosticsPage.tsx`
- Create: `tests/component/settings-page.test.tsx`
- Create: `tests/component/settings-navigation.test.tsx`
- Create: `tests/component/diagnostics-page.test.tsx`

**Required behavior:**

- Match `214:1303` and `42:11`.
- Own Settings -> Snapshots, Settings -> Diagnostics, and both return paths.
- Keep the Settings primary tab active on all three routes.
- Include the global persistent-startup switch from FDM-596.
- Remove suggestion requirements and all stale node references.
- Test scroll containment, query refresh, keyboard navigation, import/export validation, diagnostics recheck/copy/export, and recovery errors.

## 7. Release verification under FDM-603

### Task 11: Add visual, accessibility, and real-Chrome acceptance

**Files:**

- Create: `tests/e2e/fixtures.ts`
- Create: `tests/e2e/popup-manager.spec.ts`
- Create: `tests/e2e/manager-navigation.spec.ts`
- Create or update: `docs/release-checklist.md`
- Modify as needed: `playwright.config.ts`

**Automated browser tests:**

1. Build and load `.output/chrome-mv3` in a fresh persistent Chromium profile.
2. Click the extension toolbar action and assert the popup viewport is 520 × 600.
3. Assert Groups opens first and no content is clipped outside the viewport.
4. Assert the header and primary navigation remain fixed while each long body scrolls.
5. Assert the Groups navigator remains fixed while the inspector scrolls to Persistent tabs.
6. Reach Rules overview/editor/expanded state, Activity, Settings, Snapshots, Diagnostics, the actions menu, and delete confirmation.
7. Assert Settings remains the active primary destination for Snapshots and Diagnostics and that both return paths work.
8. Assert focus order, keyboard operation, Escape handling, focus restoration, and 200% zoom behavior.
9. Exercise group autosave, rule Save/Cancel, duplicate/delete, disabled-group routing, persistent-tab section states, and one Activity Undo.
10. Capture 520 × 600 screenshots for all ten canonical nodes/states and compare them with reviewed baselines.

**Repository gates:**

```powershell
npm ci
npm run docs:chrome:validate
npm run test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

**Manual Chrome smoke:**

- Load the unpacked production build in current Chrome Stable with a fresh normal profile.
- Click the toolbar icon and confirm the 520 × 600 Groups manager opens without clipping.
- Verify all canonical destinations and overlays are reachable.
- Verify a group edit survives popup close and Chrome restart.
- Verify a rule Save changes routing, Cancel does not, and a disabled group is not selected automatically.
- Verify persistent definitions are managed in the group inspector and the startup switch is in Settings.
- Verify no Quick Actions, suggestion, Templates, or standalone Persistent tabs surface exists.

## 8. Final completion criteria

The reconciliation is complete only when:

- the ten Figma frames and their structural metadata pass the 520 × 600 review;
- the design specification and original implementation plan contain no active stale requirements;
- FDM-591 remains Done, FDM-598 through FDM-600 have the required decision states, and the exact blocker graph is verified by readback;
- the popup and options entry point share one manager implementation;
- `ManagedGroup.enabled` is migrated, portable, persisted, and enforced without changing UUID identity;
- Groups autosave and Rules Save/Cancel have public-behavior tests;
- the visual editor produces only IF/AND/NOT while the pure engine retains compatible stored evaluation;
- Persistent tabs are integrated under Groups and Settings owns only the startup switch;
- Activity is the only Undo surface;
- Settings, Snapshots, and Diagnostics have clear round-trip navigation;
- all repository gates pass; and
- the unpacked-Chrome smoke evidence confirms the toolbar opens the 520 × 600 Groups manager without clipping.
