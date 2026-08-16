# CI Agent Workflow Optimization Design

## Goal

Refactor TabRoute's GitHub Actions CI so agent-driven PR iteration gets fast, actionable feedback without weakening the Chrome/MV3 production gates.

The existing workflow is correct but serial: it installs Playwright/Chromium before cheap static checks, runs the full Vitest suite twice (`test` and `test:coverage`), and provides limited persisted evidence when browser gates fail.

## Selected approach

Use three responsibility-focused jobs with Quality as the shared prerequisite:

```text
               ┌─> Chrome Integration
Quality ───────┤
               └─> Package
```

1. **Quality** — cheap, browser-free validation first.
2. **Chrome Integration** — isolated Chromium/workbench/real-extension verification after Quality passes.
3. **Package** — independently rebuild and scan the final Chrome ZIP after Quality passes.

Chrome Integration and Package do not depend on each other. Once Quality is green, both can provide feedback concurrently. The workflow is successful only when all three jobs pass.

This keeps the strongest existing checks while making common failures fail earlier and avoiding an unnecessary browser-to-package dependency.

### Alternatives considered

- **Keep one job and only reorder steps.** Lowest change risk, but still leaves duplicate Vitest execution, poor failure isolation, and no clear CI boundaries.
- **Run all jobs fully in parallel.** Fast wall-clock completion when everything passes, but wastes Chromium and packaging work on commits that fail formatting/typecheck.
- **Strict `Quality → Chrome Integration → Package` chain.** Avoids packaging work when browser verification fails, but makes independent packaging feedback wait for the longest stage without adding a correctness guarantee.
- **Selected fan-out after Quality.** Cheap checks gate the expensive work, while Chrome Integration and Package run independently from the same verified commit.

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

`npm test -- --run` is removed from CI because `npm run test:coverage` already executes the complete configured Vitest suite. Local developers keep both scripts available.

Success criteria:

- formatting/type/lint failures are reported before any Chromium installation;
- unit/component tests execute once in CI;
- coverage remains mandatory;
- no browser dependency is installed by this job.

### 2. Chrome Integration

Depends only on `Quality`.

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

Keep these commands separate so CI immediately identifies whether fixture/workbench behavior, the production extension gate, or popup smoke failed.

Existing build semantics remain intentional:

- `test:workbench` owns its fixture/workbench build behavior;
- `test:extension` still builds and scans both workbench and production graphs before running real-extension assertions against its recorded production build;
- `smoke:popup` keeps its fresh production build in this iteration.

Do not pass build artifacts between these commands or between jobs as part of this optimization.

Failure evidence is uploaded with `actions/upload-artifact@v4` when the job fails. Include paths when present:

- `.workbench/artifacts/`
- `playwright-report/`
- `test-results/`

Use `if-no-files-found: ignore` so failures before artifact creation do not hide the original error. Keep artifacts for 7 days. `test-results/` is included because Playwright may place per-test error context and future attachments there even when the manually managed extension contexts are not covered by config-level tracing.

### 3. Package

Depends only on `Quality`, so it can run in parallel with Chrome Integration.

Setup Node/npm normally, then run:

1. `npm run zip`
2. `npm run verify:zip`

Do not run `npm run build` first. WXT's `zip` command performs the production build before creating the Chrome ZIP, so an explicit build immediately before it is redundant.

Package deliberately rebuilds independently instead of consuming the Chrome Integration production build. This verifies the actual distribution command and keeps the shipping artifact isolated from browser-test state.

The production ZIP scan remains the final shipping-shape guarantee that workbench/test-only code does not leak into the packaged extension.

## Playwright diagnostics

TabRoute's extension tests launch Chromium through manually managed persistent contexts in the workbench/browser harness. Playwright Test configuration alone therefore must not be treated as sufficient evidence that traces or automatic screenshots cover those extension contexts.

For this CI optimization:

- preserve the current Chromium-only behavior and 180-second test timeout;
- keep a console-friendly reporter;
- produce an HTML report in CI at `playwright-report/` with auto-open disabled;
- upload that report together with existing `.workbench/artifacts/` and `test-results/` when Chrome Integration fails.

Explicit tracing or failure-screenshot lifecycle support for manually managed extension contexts is a separate harness improvement and is not part of this branch.

## Caching and setup

Keep `actions/setup-node` npm caching in each job.

Do not cache or share:

- `node_modules`;
- WXT build output;
- `.workbench/tmp` builds;
- browser test build artifacts between jobs.

Each job runs its own `npm ci`, including the repository `prepare` lifecycle, so jobs stay reproducible and independent.

Playwright browser caching is intentionally deferred until post-change timing data shows that its complexity is worthwhile.

## Concurrency and triggers

Keep the existing triggers:

- pull requests targeting `main`;
- pushes to `main`;
- manual dispatch.

Keep `cancel-in-progress: true` using the existing per-workflow/ref concurrency group. This is especially important for agent-driven iteration because superseded commits should stop consuming CI resources.

## Failure behavior

- Quality failure prevents both Chrome Integration and Package from starting.
- After Quality succeeds, Chrome Integration and Package are independent and may run concurrently.
- Chrome Integration failure uploads diagnostic artifacts but does not suppress independent Package feedback.
- Package failure is isolated to production ZIP/build concerns.
- Job names make GitHub status checks immediately identify the failing layer instead of reporting a single generic `Verify` failure.

Changing the status name from the existing `Verify` job to three named jobs may require a separate branch-protection/ruleset update if `Verify` is explicitly required. GitHub settings changes are outside this branch.

## Scope

Included:

- `.github/workflows/ci.yml`
- `playwright.config.ts` for CI reporting
- documentation describing the updated CI matrix and build semantics

Not included:

- changes to extension runtime behavior;
- changes to production feature code;
- test semantic rewrites;
- changes to repeated workbench fixture build isolation;
- explicit manual-context Playwright tracing instrumentation;
- branch-protection policy changes;
- external CI services.

## Verification

Before opening/finishing the PR:

1. Validate workflow YAML structure by inspection and GitHub Actions execution.
2. Confirm Quality can pass without browser installation.
3. Confirm the full configured Vitest suite and coverage pass exactly once in CI.
4. Confirm Workbench, production extension, and popup smoke gates pass in Chrome Integration.
5. Confirm `npm run zip` succeeds without a preceding `npm run build`, and `npm run verify:zip` scans that generated ZIP successfully.
6. Confirm Chrome Integration uploads `.workbench/artifacts/`, `playwright-report/`, and `test-results/` on failure when those paths exist.
7. Confirm Package and Chrome Integration both depend only on Quality.
8. Confirm no Chrome/runtime/product behavior files changed.
9. Compare post-change CI timings before pursuing further caching or workbench build-reuse optimization.
