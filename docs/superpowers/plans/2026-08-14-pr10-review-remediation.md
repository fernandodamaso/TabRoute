# PR 10 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every currently valid non-outdated review finding on PR #10 without weakening existing behavior or introducing a local Linux/WSL dependency.

**Architecture:** Keep all Chrome mutations inside the existing Action Engine/controller boundaries. Fix persistence/startup invariants first, then snapshots/duplicates/Undo reliability, and finally manager UI/validation. Every behavioral fix is protected by a regression test and the full repository CI gate.

**Tech Stack:** TypeScript, WXT, Chrome Manifest V3 APIs, Vitest, React Testing Library, Playwright.

## Global Constraints

- Local verification on Windows must run natively with Node.js/Playwright. Do not install or require WSL.
- GitHub Actions may use its remote Ubuntu runner; that does not create a local Linux dependency.
- Preserve Activity as the only Undo surface.
- Preserve Action Engine mutation boundaries and checkpoint requirements.
- Do not add notifications, host permissions, incognito management, Templates, or another primary navigation destination.

---

### Task 1: Persistent/startup correctness

**Files:**

- Modify: `src/persistence/startupRestore.ts`
- Modify: `src/persistence/windowOwnership.ts`
- Modify: `src/controller/persistentRepairRunner.ts`
- Modify: `src/controller/controller.ts`
- Test: `tests/unit/pr10-review-regressions-round2.test.ts`

- [ ] Add failing tests for individually persistent startup restore, post-repair ordering, startup retry after failed/degraded restore, and persistence installation only after durable save succeeds.
- [ ] Execute repair actions before computing persistent ordering from fresh inventory/associations.
- [ ] Treat groups containing persistent definitions as startup-restorable even when whole-group pinning is off.
- [ ] Preserve/reschedule startup recovery when the restore plan does not complete successfully.
- [ ] Persist rule-created persistence before installing it in the live controller.

### Task 2: Snapshot correctness and failure reporting

**Files:**

- Modify: `src/snapshots/restoreSnapshot.ts`
- Modify: `src/snapshots/captureSnapshot.ts`
- Modify: `src/snapshots/snapshotService.ts`
- Modify: `src/snapshots/snapshotScheduler.ts`
- Test: `tests/unit/pr10-review-regressions-round2.test.ts`

- [ ] Add failing tests for unique snapshot member claims, live collapsed/order capture, degraded restore reporting, and automatic snapshot failure Activity.
- [ ] Remove cross-member TabRef reuse; every snapshot member must own one live or created tab.
- [ ] Capture live presentation from ownership when available.
- [ ] Return failure for degraded/partial restores.
- [ ] Record automatic snapshot capture failures locally.

### Task 3: Duplicate and rule safety

**Files:**

- Modify: `src/duplicates/resolveDuplicate.ts`
- Modify: `src/duplicates/planDuplicateClose.ts`
- Modify: `src/actions/types.ts`
- Modify: `src/actions/executeActionPlan.ts`
- Modify: `src/rules/ruleEngine.ts`
- Test: `tests/unit/pr10-review-regressions-round2.test.ts`

- [ ] Add failing tests for same-managed-group instances in different windows, duplicate navigation races, and opener URL suffix hostname boundaries.
- [ ] Resolve destination placement using both Chrome group ID and window ID.
- [ ] Carry the planned duplicate policy/key into close actions and revalidate both fresh tabs immediately before removal.
- [ ] Use hostname equality-or-subdomain semantics for opener URL suffix matching.

### Task 4: Undo and Activity reliability

**Files:**

- Modify: `src/actions/executeRoutePlan.ts`
- Modify: `src/background/managerMessageRouter.ts`
- Modify: `src/ui/manager/ActivityPage.tsx`
- Modify: `src/ui/manager/ManagerApp.tsx`
- Test: `tests/unit/pr10-review-regressions-round2.test.ts`
- Test: `tests/component/pr10-review-regressions-round2.test.tsx`

- [ ] Add failing tests proving Activity storage failure cannot turn a completed route into a failed mutation.
- [ ] Make route Activity logging best-effort after Chrome state has been verified.
- [ ] Propagate expired/unavailable/degraded Undo results through the manager response.
- [ ] Surface failed Undo to the Activity UI.

### Task 5: Settings, snapshot scope, alarm refresh, and validation

**Files:**

- Modify: `src/background/managerMessageRouter.ts`
- Modify: `entrypoints/background.ts`
- Modify: `src/ui/manager/pages/SettingsPage.tsx`
- Modify: `src/ui/manager/pages/SnapshotsPage.tsx`
- Modify: `src/ui/manager/ManagerApp.tsx`
- Modify: `src/domain/schemas.ts`
- Test: `tests/component/pr10-review-regressions-round2.test.tsx`
- Test: `tests/unit/pr10-review-regressions-round2.test.ts`

- [ ] Add failing tests for native alarm rescheduling, fresh configuration export, imported interval synchronization, global pattern duplicate policy editing, single-group named snapshots, and HTTP(S)-only persistent canonical URLs.
- [ ] Refresh the interval alarm after a successful local interval setting change.
- [ ] Export the configuration returned by the background rather than a stale render closure.
- [ ] Synchronize local input drafts when configuration changes without clobbering active edits.
- [ ] Add a group-scope choice to named snapshot capture.
- [ ] Expose and edit the global pattern duplicate policy.
- [ ] Reject non-HTTP(S) persistent canonical URLs during configuration validation.

### Task 6: Verification and review cleanup

**Files:**

- No production changes unless verification exposes a regression.

- [ ] Run the complete GitHub CI workflow and require all gates to pass.
- [ ] Re-read every non-outdated unresolved PR review thread against the final head.
- [ ] Resolve only findings demonstrably fixed by current code/tests.
- [ ] If a new review batch appears, triage it before declaring the PR ready.
