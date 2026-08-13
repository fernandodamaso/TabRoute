# Agent Development Workbench

The workbench is TabRoute's Chrome-only, Manifest V3 harness for exercising `ManagerApp` through public browser contracts without touching the user's Chrome profile.

## Commands

| npm script        | Purpose                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `build:workbench` | Build the workbench graph only                                             |
| `workbench`       | Run fixture mode (`--mode fixture`) against isolated Chromium              |
| `workbench:real`  | Run real mode (`--mode real`, `wb:default` only) against isolated Chromium |
| `test:workbench`  | Playwright fixture coverage for all 15 scenarios                           |
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
- Fifteen fixture scenarios: `wb:default`, `wb:empty-groups`, `wb:dense-groups`, `wb:enabled-group`, `wb:disabled-group`, `wb:empty-persistent-tabs`, `wb:populated-persistent-tabs`, `wb:mixed-rules-overview`, `wb:new-rule`, `wb:edit-rule`, `wb:confirmation-overlay`, `wb:loading`, `wb:slow`, `wb:validation-error`, `wb:offline`. Activity and Settings are routes exercised through the host, not separate scenario ids.

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

## Quality matrix

```text
npm run docs:chrome:validate
npm run typecheck
npm run lint
npm run format:check
npm test -- --run
npm run test:coverage
npm run test:workbench
npm run test:extension
npm run smoke:popup
npm run build
```
