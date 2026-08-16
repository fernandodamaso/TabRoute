# Agent Development Workbench

The workbench is TabRoute's Chrome-only, Manifest V3 harness for exercising `ManagerApp` through public browser contracts without touching the user's Chrome profile.

Project instructions in `AGENTS.md` and `skills/chrome-tab-manager/SKILL.md` point here. Read this file before manager UI, fixture, e2e, or live Chromium work.

## Commands

| npm script        | Purpose                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `build:workbench` | Build the workbench graph only                                             |
| `workbench`       | Run fixture mode (`--mode fixture`) against isolated Chromium              |
| `workbench:real`  | Run real mode (`--mode real`, `wb:default` only) against isolated Chromium |
| `test:workbench`  | Playwright fixture coverage for all 17 scenarios                           |
| `test:extension`  | Production gate build/scan plus real MV3 options tests                     |
| `smoke:popup`     | Production popup smoke at 520×600 without workbench markers                |

All six scripts dispatch through `scripts/workbench/cli.ts`.

## Architecture

- **`ManagerApp`** is the only manager UI implementation.
- **`ManagerTransport`** is the only state/request seam. Fixture and real adapters implement the same `request(message)` operation.
- **Fixture graph** (`TABROUTE_WORKBENCH=1`) includes `src/workbench`, host controls, scenario registry, and markers.
- **Production graph** (`TABROUTE_WORKBENCH=0`) excludes every workbench marker and HTML entry.

Canonical fixture URL (after extension id discovery):

```text
chrome-extension://<id>/options.html?workbench=1&mode=fixture&route=groups&scenario=wb%3Adefault&deep-link=none&latency=0&failure=none
```

## Stable runner codes

The runner and artifact layer expose exactly six stable failure codes:

1. `WORKBENCH_ARGUMENT`
2. `WORKBENCH_WORKER_TIMEOUT`
3. `WORKBENCH_MANAGER_TIMEOUT`
4. `WORKBENCH_CLEANUP_FAILED`
5. `WORKBENCH_CAPACITY`
6. `WORKBENCH_ARTIFACT_LIMIT`

## Viewport and scenarios

- Manager preview is **520×600** (`data-manager-viewport="520x600"` on popup; `.workbench-preview` in the host).
- Seventeen fixture scenarios: `wb:default`, `wb:empty-groups`, `wb:dense-groups`, `wb:enabled-group`, `wb:disabled-group`, `wb:empty-persistent-tabs`, `wb:populated-persistent-tabs`, `wb:mixed-rules-overview`, `wb:new-rule`, `wb:edit-rule`, `wb:confirmation-overlay`, `wb:loading`, `wb:slow`, `wb:validation-error`, `wb:offline`, `wb:sync-incomplete`, `wb:local-budget`. Activity and Settings are routes exercised through the host, not separate scenario ids.

## Removal path

- Workbench code lives under `src/workbench/` and `scripts/workbench/` and is excluded from the production graph by `wxt.config.ts`.
- Removing the harness means deleting those trees, the six npm scripts, Playwright e2e specs, and `.workbench/` artifacts; production `ManagerApp` remains the shipping UI.

## Non-goals

- No Sync/Activity/Undo/snapshot persistence in workbench tests.
- No Chrome tab/group mutations from workbench UI.
- No branded Chrome packaging, store submission, or user-profile automation.

## Isolation rules

- Never attach to the user's Chrome, a fixed extension id, `chrome://extensions`, toolbar UI, Computer Use, or manual storage seeding from tests.
- Each run uses a fresh persistent profile under the OS temp directory, a run-scoped build under `.workbench/tmp/<run-id>/`, derived extension ids, leases, and bounded artifacts under `.workbench/artifacts/<run-id>/`.
- `test:extension` builds **both** graphs, scans production, writes `ProductionGateResult`, then runs real assertions only against the production build path recorded in `.workbench/tmp/last-production-gate-result-path`.

## Canonical frame evidence

The committed canonical PNG/JSON files are release evidence for the manager's
520×600 structural contract. `npm run test:extension` validates the structure
on every platform; it does not require a local Linux installation. Pixel-level
comparison is an opt-in diagnostic for a matching rendering environment:

```text
TABROUTE_COMPARE_CANONICAL_FRAMES=1 npm run test:extension
```

Do not install WSL or Linux tooling solely to run the local extension gate.

## Future UI issue checklist

When changing manager UI behavior, ship evidence in this order:

1. Public **Vitest** component tests against `ManagerTransport` mocks.
2. **Fixture** updates in `src/workbench/scenarios.ts` when new public states are needed.
3. **Playwright** workbench tests (`npm run test:workbench`) for browser-observable focus, scroll, overlay, and command-log contracts.
4. Screenshot/evidence only when the public layout contract changes.
5. **`npm run test:extension`** / production scan when the production graph or MV3 messaging changes.

## Feature-storage ownership

The workbench owns transport, fixture display, host controls, runner evidence, and production isolation. Feature issues own Sync, Local shadow, Activity, Undo, snapshots, and persistent-tab storage. Do not add Sync, Activity, Undo, snapshot persistence, or Chrome tab/group mutations from workbench UI code.

## Next enabling work

FDM-619 (workbench) is the prerequisite for later feature issues such as FDM-593. Do not start downstream feature work until the quality matrix below is green.

## Branded Chrome release

Shipping a branded Chrome build remains a separate human release step after the automated matrix passes. The matrix does not replace manual Chrome Web Store or enterprise packaging review.

## CI quality matrix

CI is split into three responsibility-focused checks. Quality runs first; once it passes, Chrome Integration and Package can run independently from the same commit.

### Quality

Browser-free validation:

```text
npm run docs:chrome:validate
npm run format:check
npm run typecheck
npm run lint
npm run test:coverage
```

`npm run test:coverage` is the single Vitest execution in CI and covers the complete configured unit/component suite while producing coverage. `npm test -- --run` remains available as a faster local developer command when coverage is not needed.

### Chrome Integration

Chromium-backed verification:

```text
npm run test:workbench
npm run test:extension
npm run smoke:popup
```

`test:extension` keeps its paired workbench/production build and scan semantics. Browser jobs do not reuse Package output or pass production builds between jobs.

When Chrome Integration fails in GitHub Actions, CI uploads the existing `.workbench/artifacts/` evidence, the Playwright HTML report, and `test-results/` when present. This keeps runner evidence plus Playwright error-context files available to the next debugging agent. TabRoute's extension browser sessions use manually managed persistent contexts, so explicit trace/screenshot lifecycle instrumentation for those contexts is a separate harness concern rather than a config-only CI assumption.

### Package

Shipping-shape verification:

```text
npm run zip
npm run verify:zip
```

`npm run zip` performs the production build as part of creating the Chrome ZIP, so CI does not run a redundant `npm run build` immediately before it. Package deliberately rebuilds independently from Chrome Integration so the generated ZIP represents the real distribution command and is scanned in isolation.

For local work, `npm run build` remains available when an unpacked production extension is needed without producing a ZIP.
