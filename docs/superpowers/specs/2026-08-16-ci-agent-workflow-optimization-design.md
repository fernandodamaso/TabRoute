# CI Agent Workflow Optimization Design

## Goal

Refactor TabRoute's GitHub Actions CI so agent-driven PR iteration gets fast, actionable feedback without weakening the Chrome/MV3 production gates.

The existing workflow is correct but serial: it installs Playwright/Chromium before cheap static checks, runs the full Vitest suite twice (`test` and `test:coverage`), and provides limited persisted evidence when browser gates fail.

## Selected approach

Use three ordered jobs:

1. **Quality** — cheap, browser-free validation first.
2. **Chrome integration** — isolated Chromium/workbench/real-extension verification only after Quality passes.
3. **Package** — final production build, ZIP, and production-tree scan only after the browser gate passes.

This keeps the strongest existing checks while making common failures fail earlier and with less wasted work.

### Alternatives considered

- **Keep one job and only reorder steps.** Lowest change risk, but still leaves duplicate Vitest execution, poor failure isolation, and no clear CI boundaries.
- **Run all jobs fully in parallel.** Fast wall-clock completion when everything passes, but wastes Chromium and packaging work on commits that fail formatting/typecheck and duplicates dependency setup aggressively.
- **Selected staged jobs.** Slightly more workflow YAML, but best balance for frequent agent commits: fail cheap first, then spend browser/package resources only on viable commits.

## Job design

### 1. Quality

Runs on `ubuntu-latest` without installing Playwright browsers.

Order:

1. Checkout
2. Setup Node 24 with npm cache
3. Install repository npm version (`npm@11.17.0`)
4. `npm ci`
5. `npm run docs:chrome:validate`
6. `npm run format:check`
7. `npm run typecheck`
8. `npm run lint`
9. `npm run test:coverage`

`npm test -- --run` is removed from CI because `npm run test:coverage` already executes the complete Vitest suite. Local developers keep both scripts available.

Success criteria:

- formatting/type/lint failures are reported before any Chromium installation;
- unit/component tests execute once in CI;
- coverage remains mandatory.

### 2. Chrome integration

Depends on `Quality`.

Setup:

1. Checkout
2. Setup Node/npm cache
3. Install repository npm version
4. `npm ci`
5. `npx playwright install chromium --with-deps`

Validation:

1. `npm run test:workbench`
2. `npm run test:extension`
3. `npm run smoke:popup`

Failure evidence is uploaded with `actions/upload-artifact@v4` when the job fails. The artifact should include paths when present:

- `.workbench/artifacts/`
- `playwright-report/`
- `test-results/`

Use `if-no-files-found: ignore` so missing optional Playwright folders do not hide the original failure. Keep artifacts for 7 days.

### 3. Package

Depends on `Chrome integration`.

Setup Node/npm normally, then run:

1. `npm run build`
2. `npm run zip`
3. `npm run verify:zip`

This remains the final shipping-shape gate. The production ZIP scan must continue to prove workbench/test-only code does not leak into the packaged extension.

## Playwright diagnostics

Update `playwright.config.ts` only enough to improve CI evidence:

- retain trace on failure in CI;
- capture screenshots on failure in CI;
- produce an HTML report in CI without auto-opening it;
- preserve current Chromium-only behavior and 180-second test timeout.

Local behavior should remain lightweight; diagnostics are primarily for CI failure analysis.

## Concurrency and triggers

Keep the existing triggers:

- pull requests targeting `main`;
- pushes to `main`;
- manual dispatch.

Keep `cancel-in-progress: true` using the existing per-workflow/ref concurrency group. This is especially important for agent-driven iteration because superseded commits should stop consuming CI resources.

## Failure behavior

- Quality failure prevents browser and package jobs from starting.
- Chrome integration failure prevents packaging and uploads diagnostic artifacts.
- Package failure is isolated to production build/ZIP concerns.
- Job names make GitHub status checks immediately identify the failing layer instead of reporting a single generic `Verify` failure.

## Scope

Included:

- `.github/workflows/ci.yml`
- `playwright.config.ts` if needed for failure evidence
- documentation describing the updated quality matrix

Not included:

- changes to extension runtime behavior;
- changes to production feature code;
- test semantic rewrites;
- branch-protection policy changes;
- external CI services.

## Verification

Before opening/finishing the PR:

1. Validate workflow YAML structure by inspection and GitHub Actions execution.
2. Confirm Quality can pass without browser installation.
3. Confirm the full Vitest suite and coverage still pass exactly once in CI.
4. Confirm Workbench, production extension, and popup smoke gates pass in Chrome integration.
5. Confirm build, ZIP, and ZIP scan pass in Package.
6. Confirm a deliberately failed browser test would have artifact upload paths configured; no deliberate failing commit is required on the final branch.
7. Confirm no Chrome/runtime/product behavior files changed.
