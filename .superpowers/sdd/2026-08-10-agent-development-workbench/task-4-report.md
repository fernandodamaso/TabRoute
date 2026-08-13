# FDM-623 Task 4 execution report

## Status

DONE_WITH_CONCERNS. Task 4 only was implemented in the isolated worktree `C:\Users\ferna\.codex\worktrees\fdm-623\TabRoute`.

## Base and final SHA

- Base: `ba423c5847756c0e8378700f721f5daf23a5730f`
- Final: `9de3a30`

## Files changed

- Created `scripts/workbench/contracts.ts`, `paths.ts`, `lock.ts`, `artifacts.ts`, `leases.ts`, and `production-scan.ts`.
- Created the five requested unit suites and `tests/helpers/workbench-lock-worker.ts`.
- Modified `wxt.config.ts` for `TABROUTE_WXT_OUT_DIR` and the exact production permission set.
- Modified `.gitignore` for `.workbench/artifacts/` and `.workbench/tmp/`.

## RED evidence

Command:

```text
npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts
```

Expected and observed: all five suites failed before running tests because the five new workbench modules did not exist. This was the intended missing-module RED state.

## GREEN evidence

```text
npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts
```

Result: PASS, 5 files and 14 tests.

```text
npm run typecheck
```

Result: PASS.

```text
npm run build
npx tsx -e "import { scanProductionBuild } from './scripts/workbench/production-scan.ts'; (async () => { const result = await scanProductionBuild('.output/chrome-mv3'); console.log(JSON.stringify(result)); if (!result.ok) process.exit(1); })();"
```

Result: PASS. The production build was scanned successfully with `ok: true` and no errors.

## Acceptance criteria mapping

- Shared discriminated RunResult contracts and bounded artifact failure are defined in `contracts.ts`; unknown extension IDs are omitted.
- Metadata caps and UTF-8 reservation encoding are applied before required result writes.
- Artifact writes use the exclusive lock, atomic replacement, path validation, active/global budgets, deterministic evidence ordering, and text-log rotation.
- Leases use five-second heartbeat constants, two-minute dead-PID and ten-minute unavailable-liveness rules, bounded cleanup retries, abandoned result updates, and an eight-active lease capacity limit.
- The cross-process lock uses `fs.open(..., "wx")`, owner metadata, heartbeat refresh, bounded retries, and stale-owner recovery.
- The production scan reads only the explicit built path, checks all UTF-8 assets for workbench markers, checks HTML basenames, and enforces MV3, Chrome-only, `incognito: "not_allowed"`, exact permissions, and no `commands`.
- WXT output is configurable with `TABROUTE_WXT_OUT_DIR ?? ".output"`; the production manifest graph exclusion remains in place.
- No package scripts, runner, CLI, Chromium launch, browser automation, feature storage, or later task work was added.

## Concurrency and boundary evidence

- The focused concurrency suite verifies same-process serialization and spawns two real Node processes through `tests/helpers/workbench-lock-worker.ts` against the same lock.
- Artifact and cleanup targets are resolved and checked before writes/removal; unresolved roots are rejected.
- Atomic writes use a temporary sibling file followed by rename and remove the temporary file on failure.
- Required metadata is capped and measured as UTF-8 bytes before publishing `results.json`.

## Self-review

- `git diff --check`: PASS.
- `npm run typecheck`: PASS.
- Focused Task 4 tests: PASS.
- Production build and scan: PASS.
- The FDM-622 production exclusion transform was preserved.

## Scope confirmation

Only the Task 4 files named in the brief were changed, plus this required report. `.tabroute-ledger/` and `docs/design-review/` were not touched. No remote systems, user Chrome, Computer Use, Figma, Linear, PR, push, or merge actions were used.

## Concerns

- The full `npm test` command has an existing 5-second timeout in `tests/unit/shell.test.ts` when all Vitest workers run concurrently. The same shell test passes alone, and the production build passes directly; no Task 4 test failed.
- The report final SHA is filled after commit.

## Fix Round 1

### Scope and findings addressed

- Added strict owned-profile validation. Cleanup now accepts only an absolute profile path under the configured profile root with the run-id basename, and rejects worktree children, parent/root, sibling, unrelated, and unresolved targets.
- Added terminal retention pruning by `terminalAt` (seven days, then 20 terminal runs), recorded `capturedAt` optional-evidence ordering, category-based optional indexes, and required-metadata protection.
- Added minimal bounded artifact-limit replacement, UTF-8 caps, reservation checks, atomic replacement, and affected/global budget accounting.
- Hardened lock heartbeat writes with atomic replacement, owner tokens, stale-owner revalidation, and bounded domain codes.
- Hardened reaping with started-result validation, clean abandoned result construction, bounded errors, owned cleanup paths, and initial cleanup plus exact 250/500/1000 ms retries.
- Added exact runtime RunResult validation, fail-closed lease/artifact reads, five-second heartbeat lifecycle, recursive Chrome-only production scanning, binary marker scanning, and two-process lease-eight capacity coverage.

### RED command and result

```text
npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts
```

Observed after adding Fix Round 1 tests: 5 files ran, 10 tests failed and 19 passed. Failures covered missing path validation, retry count, heartbeat lifecycle, bounded result shape, terminal pruning, replacement, binary scan, and two-process lease capacity. These were expected RED failures before the fixes.

### GREEN and verification commands

```text
npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts
```

PASS: 5 files, 29 tests.

```text
npm test -- --run --testTimeout=15000
```

PASS: 29 files, 166 tests. Vitest emitted the existing Node `DEP0190` child-process warning from the shell test; no test failed.

```text
npm run typecheck
npm run lint
npm run build
npx tsx -e "import { scanProductionBuild } from './scripts/workbench/production-scan.ts'; (async () => { const result = await scanProductionBuild('.output/chrome-mv3'); console.log(JSON.stringify(result)); if (!result.ok) process.exit(1); })();"
git diff --check
```

All PASS. The production scan output was `{"ok":true,"errors":[],"buildPath":"C:\\Users\\ferna\\.codex\\worktrees\\fdm-623\\TabRoute\\.output\\chrome-mv3"}`. `git diff --check` emitted only Git's CRLF conversion warnings for newly edited files.

### Fix Round 1 files

Modified only the approved Task 4 files: the six `scripts/workbench` modules, five named unit tests, the named lock worker helper, and this report. No Task 5 files, package scripts, remote systems, or ignored design/ledger files were changed.

### Fix Round 1 SHA and concerns

- SHA: `6da252d`
- Concern: the full suite retains the existing Node `DEP0190` warning from `tests/unit/shell.test.ts`; it is non-failing and outside this slice.

## Fix Round 2

### Scope and covered findings

- Direct-child owned profile validation now rejects nested corrupt paths.
- Finalization now counts the affected terminal run and retains at most 20 terminal runs. Optional retention has explicit video, trace, screenshot category order and recorded-capture ordering.
- Store-level required metadata writes now enforce affected/global reservation boundaries, including encoded minus/exact/plus cases and atomic minimal overflow replacement.
- Lock stale recovery and heartbeat refresh revalidate owner tokens before replacement; deterministic race tests prove a replacement lock is not removed or overwritten.
- Started-result validation now checks nested transport records, readiness, screenshots, assertions, lease, cleanup, route, deep-link, mode, scenario, URL, and path fields. Reaping accepts only valid started results and writes exact abandoned success/failure shapes with initial cleanup plus 250/500/1000 ms retries.
- Every RunResult branch validates exact required/forbidden keys and types, including minimal artifact failures.
- Missing and malformed `lease.json` files fail closed with `WORKBENCH_CAPACITY`.
- Production scan rejects mixed/non-Chrome targets and scans nested manifest paths and binary marker bytes.
- Global optional pruning resolves candidates as `<runId>/<relativePath>` and reads the corresponding per-run index.

### Fix Round 2 RED

Command:

```text
npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts
```

Observed before the Fix Round 2 implementation: 5 files, 36 tests, 7 failures and 29 passes. The failures covered mixed targets, nested profile paths, terminal count, category/global retention, stale replacement ownership, missing leases, and retry shape. Additional nested-contract and store-boundary tests were added while closing the same findings and are included in the GREEN matrix.

### Fix Round 2 GREEN and verification

```text
npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts
```

PASS: 5 files, 41 tests.

```text
npm test -- --run --testTimeout=15000
```

PASS: 29 files, 178 tests. Vitest emitted the existing Node `DEP0190` child-process warning; no test failed.

```text
npm run typecheck
npm run lint
npm run build
npx tsx -e "import { scanProductionBuild } from './scripts/workbench/production-scan.ts'; (async () => { const result = await scanProductionBuild('.output/chrome-mv3'); console.log(JSON.stringify(result)); if (!result.ok) process.exit(1); })();"
git diff --check
```

All PASS. Production scan output: `{"ok":true,"errors":[],"buildPath":"C:\\Users\\ferna\\.codex\\worktrees\\fdm-623\\TabRoute\\.output\\chrome-mv3"}`. `git diff --check` emitted only CRLF conversion warnings.

### Fix Round 2 files and handoff

Only the approved Task 4 modules, five named tests, the named lock worker, and this report changed. No Task 5 work, package scripts, remote mutation, push, merge, or design/ledger changes were made.

- SHA: `2c46124`
- Concern: the existing Node `DEP0190` warning remains non-failing.

## Fix Round 3

### Scope and covered findings

- Required lease/status/result/error writes now share one affected-run and global 2 MiB reservation. Existing required bytes plus the candidate payload are measured, while optional writes preserve the reservation.
- Pending request records now accept the exact shape and reject extra fields. Nested manager messages, events, deep links, assertions, leases, cleanup objects, and bounded errors reject unknown keys and invalid types. Minimal artifact failures require a worktree path, exact cleanup shape, and a string extension id when present.
- Stale lock recovery claims the path with an atomic rename before inspecting/removing the claimed owner, protecting replacement owners in deterministic race windows.
- The child-process helper now performs real artifact writes/pruning and orphan reaping. Tests prove serialized writes, deterministic pruning, required metadata preservation, and exactly one concurrent reaper result.
- Abandoned cleanup failure persistence is asserted by exact equality and `validateRunResult`, with bounded error output and the required retry schedule.

### Fix Round 3 RED

Command:

```text
npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts --run --testTimeout=15000
```

Observed before implementation: 4 files, 36 tests, 2 failures and 34 passes. Failures were the inverted pending-record validator and the required-metadata combined reservation bypass.

### Fix Round 3 GREEN and verification

```text
rtk npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts --run --testTimeout=15000
```

PASS: 5 files, 46 tests.

```text
rtk npm test -- --run --testTimeout=15000
```

Result: 28 files, 182 tests passed; `tests/unit/shell.test.ts` timed out at the requested 15-second test timeout during this parallel run. The isolated command below passed, and the timeout is recorded as a concern rather than hidden.

```text
rtk npx vitest run tests/unit/shell.test.ts --run --testTimeout=30000
```

PASS: 1 file, 1 test. Vitest emitted the existing Node `DEP0190` child-process warning.

```text
rtk npm run typecheck
rtk npm run lint
rtk npm run build
npx tsx -e "import { scanProductionBuild } from './scripts/workbench/production-scan.ts'; scanProductionBuild('.output/chrome-mv3').then(result => { if (!result.ok) { console.error(result.errors.join('\\n')); process.exit(1); } console.log('production scan ok'); });"
git diff --check
```

All completed successfully. Production scan output: `production scan ok`. `git diff --check` emitted only Git's existing LF-to-CRLF conversion warnings for edited files. RTK also reported that no global hook is installed; command results were unaffected.

### Fix Round 3 self-review and scope

The diff was reviewed for atomic writes, exact path/owner handling, reservation accounting, required metadata preservation, deterministic child-process ordering, and forbidden union fields. Only approved Task 4 modules, named tests/helper, and this report changed. No Task 5 work, package scripts, browser launch, remote mutation, push, merge, ledger, or design-review files were touched.

### Fix Round 3 SHA and concerns

- SHA: `30e5010f1a0b6096962a245b9d50363bdf01e60b`
- Concern: the full mandated 15-second parallel suite has one reproducible-under-load timeout in the existing shell build test; it passes alone with a 30-second timeout. The existing Node `DEP0190` warning and RTK no-hook notice remain non-failing.

## Fix Round 4

### Scope and findings addressed

- Required metadata accounting now treats lease/status/result/error as one shared reservation. Existing required bytes are counted once; optional writes consume only the remaining active/global budget and may prune optional evidence. Boundary and headroom tests cover multi-file writes and atomic replacement.
- Lock heartbeat refresh now uses an atomic displacement/publication protocol and never truncates an open descriptor. Stale recovery claims the old inode before inspection, and release uses a claim path with non-replacing restoration. Displacement-window tests preserve replacement owners.
- Heartbeat regression reads and parses refreshed `lease.json`, then performs further lifecycle operations.
- Runtime contract validation now recursively validates ManagerMessage, ManagerResponse, and ManagerTransportRecord shapes, including exact manager success/failure responses and the real `saveRule.rule` field.

### RED command and result

```text
npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts --run --testTimeout=30000
```

Observed RED: 4 failures for the new save-rule/response, heartbeat JSON, and optional-headroom regressions. The failures were behavior failures, not test collection errors.

### GREEN and verification

```text
npx vitest run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts --run --testTimeout=30000
```

PASS: 5 files, 50 tests.

```text
npm test -- --run --testTimeout=30000
npm run typecheck
npm run lint
npm run build
npx tsx -e "import { scanProductionBuild } from './scripts/workbench/production-scan.ts'; scanProductionBuild('.output/chrome-mv3').then(result => { if (!result.ok) process.exit(1); console.log('production scan ok'); });"
git diff --check
```

Full verification:

- `npm test -- --run --testTimeout=30000`: PASS, 29 files and 187 tests.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- `npm run build`: PASS.
- Production scan: `{"ok":true,"errors":[],"buildPath":"C:\\Users\\ferna\\.codex\\worktrees\\fdm-623\\TabRoute\\.output\\chrome-mv3"}`.
- `git diff --check`: PASS with Git's existing LF-to-CRLF conversion warnings only.

### Fix Round 4 SHA and concerns

- SHA: recorded after commit.
- Concern: the existing Node `DEP0190` child-process deprecation warning remains non-failing. Git reports normal LF-to-CRLF conversion warnings for edited files.

## Fix Round 5 (final permitted correction round)

### Scope and findings addressed

- Required metadata accounting now counts only root `lease.json`, `status.json`, `results.json`, and `error.json` toward the shared reservation. The optional `.artifact-index.json` and lock file are excluded from required accounting, while index bytes remain in ordinary active/global budgets. Separate affected-run and global boundaries cover multiple required files, exact/minus/plus reservation cases, and optional pruning/headroom.
- Heartbeat refresh now keeps the exclusive-create file descriptor and public lock name in place. It checks ownership after the deterministic replacement hook, refreshes from offset zero without leading NUL bytes, and cannot overwrite a replacement inode. Release and stale recovery retain non-replacing claim publication for replacement and third-contender safety.
- Recursive runtime validation now matches `src/ui/manager/types.ts`: `RuleDraft` permits omitted generated identity/timestamps, full rules require them, commands require exact values/types/keys, persistent-tabs/templates are empty fixture types, configuration literals are enforced, and fixture `scenarioId` is disjoint from real `workerGeneration`. Abandoned cleanup failures validate `profileRemoved: false`, `retainedPath`, bounded errors, and optional string `extensionId`; invalid prior results are skipped during reaping.
- `ArtifactLimitFailure` is now a minimal interface matching the fields actually returned by `createArtifactLimitFailure`; no cast hides the mismatch.

### RED command and result

```text
npx vitest run tests/unit/workbench-leases.test.ts --run --testTimeout=30000
```

Observed RED: 1 failure, 9 passed. The new malformed lease identity/timestamp test resolved `countActive()` with `1` instead of rejecting with `WORKBENCH_CAPACITY`.

### GREEN and verification

```text
npx vitest run tests/unit/workbench-leases.test.ts --run --testTimeout=30000
```

PASS: 1 file, 10 tests.

```text
rtk npm test -- --run tests/unit/workbench-result-contract.test.ts tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts --testTimeout=30000
```

PASS: 4 files, 49 tests.

```text
rtk npm test -- --run --testTimeout=30000
rtk npm run typecheck
rtk npm run lint
rtk npm run build
npx tsx -e "import { scanProductionBuild } from './scripts/workbench/production-scan.ts'; scanProductionBuild('.output/chrome-mv3').then(result => { console.log(JSON.stringify(result)); if (!result.ok) process.exit(1); });"
git diff --check
```

Results: full suite PASS, 29 files and 195 tests; typecheck PASS; lint PASS; production build PASS; production scan PASS with `{"ok":true,"errors":[]}`; `git diff --check` PASS with only normal LF-to-CRLF conversion warnings. The existing Node `DEP0190` child-process warning and RTK no-hook notice remain non-failing.

### Fix Round 5 SHA and concerns

- Final SHA placeholder: `<FINAL_SHA_AFTER_COMMIT>`
- Concern: the existing Node `DEP0190` warning and Git line-ending warnings remain non-failing and outside Task 4 behavior.

## Primary-agent continuation after the final review

The primary agent resumed FDM-623 after the bounded delegated loop. It fixed the four remaining review findings without starting Task 5:

- Required metadata now reserves unused headroom in both affected-run and global budgets for every active run. Only root `lease.json`, `status.json`, `results.json`, and `error.json` are required. Optional affected/global writes have exact minus-one, exact, and plus-one boundary coverage. A full result that fits alone but exceeds the combined reservation now falls back to a bounded artifact failure.
- Cross-process lock owner JSON is immutable after exclusive creation. Five-second heartbeats update the held inode timestamp, so the public name and parseable owner record remain intact. A short, stale-recoverable guard serializes create/release/recovery decisions; token and inode checks prevent an old owner from deleting a successor. Malformed crash remnants use the conservative ten-minute recovery rule.
- Runtime validation rejects outer `currentGroup` extras and array-valued error details.
- `ArtifactLimitFailure` has an active-lease source type, no caller casts, capped lease fields, and a factory postcondition that guarantees every returned value passes `validateRunResult`.

### RED evidence

```text
rtk npx vitest run tests/unit/workbench-artifacts.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/workbench-result-contract.test.ts --run --testTimeout=30000
```

Observed RED: 7 failures and 39 passes. Each remaining review area failed through its public seam.

### GREEN and final verification

```text
rtk npx vitest run tests/unit/workbench-artifacts.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/workbench-result-contract.test.ts tests/unit/workbench-leases.test.ts tests/unit/production-scan.test.ts --run --testTimeout=30000
rtk npm test -- --run --testTimeout=30000
rtk npm run typecheck
rtk npm run lint
rtk npm run docs:chrome:validate
rtk npm run build
npx tsx -e "import { scanProductionBuild } from './scripts/workbench/production-scan.ts'; scanProductionBuild('.output/chrome-mv3').then(result => { console.log(JSON.stringify(result)); if (!result.ok) process.exit(1); });"
git diff --check
```

Results: focused suite PASS, 5 files and 67 tests; full suite PASS, 29 files and 204 tests; typecheck PASS; lint PASS; Chrome reference validation PASS; production build PASS; production scan PASS with `{"ok":true,"errors":[]}`; diff check PASS. The existing Node `DEP0190` warning and Git line-ending warnings remain non-failing.
