# Agent Development Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add a development-only workbench that renders the existing \`ManagerApp\` through deterministic fixture and real Chrome transports, and verifies the manager in an isolated bundled Chromium profile with bounded evidence.

**Architecture:** Keep \`ManagerApp\` as the only manager implementation and make \`ManagerTransport\` the only state/request seam. Put the fixture adapter, scenario registry, workbench host, URL parser, readiness markers, and controls in a build-only \`src/workbench\` graph. Put browser lifecycle, leases, artifact budgets, evidence, and command orchestration in \`scripts/workbench\`, where Node and Playwright can own a fresh persistent profile without touching the user's Chrome.

**Tech Stack:** TypeScript 6, React 19, WXT 0.21 Chrome Manifest V3, Vitest 4 with Testing Library, Playwright 1.62 bundled Chromium, Node \`fs/promises\`, \`child_process\`, and \`path\` APIs.

## Global Constraints

- Keep the extension Chrome-only and Manifest V3 in v1.
- Keep popup, normal options, and workbench options on the same \`ManagerApp\` module.
- Keep \`ManagerTransport\` typed; fixture and real adapters must implement the same request operation.
- UI and workbench controls must not call \`chrome.tabs.group\`, \`chrome.tabs.move\`, \`chrome.tabs.ungroup\`, \`chrome.tabs.remove\`, or \`chrome.tabGroups.update\`.
- Real mode must use the existing background worker, repositories, controller, and Tab Action Engine through typed manager messages.
- Fixture mode must not import the live Chrome port, read user storage, use random UUIDs, use \`Date.now()\`, or use live Chrome inventory.
- Workbench-only controls, markers, fixture IDs, fixture registry, and fixture assets must be absent from the production output graph.
- Use the existing \`storage.local\` repository and existing controller behavior only; do not implement Sync generations, Local last-valid shadows, Activity, Undo, snapshots, or new feature persistence.
- Every run must use a unique run ID, a fresh OS temporary persistent profile, a current-worktree build, and \`.workbench/artifacts/<run-id>\` evidence.
- Enforce the exact 50 MB active-run budget, 200 MB global budget, 5 MB text-log cap, 20 terminal runs, seven-day terminal retention, eight non-stale active leases, and cleanup backoff of 250 ms, 500 ms, and 1000 ms.
- Worker readiness has a separate 15,000 ms deadline; the first manager query has a separate 5,000 ms deadline and retries only \`receiving end does not exist\` at 250 ms cadence without extending the deadline.
- Required commands are \`npm run workbench\`, \`npm run workbench:real\`, \`npm run test:workbench\`, \`npm run test:extension\`, and \`npm run smoke:popup\`.
- Do not modify Linear, Figma, \`.tabroute-ledger/\`, \`docs/design-review/\`, or implementation code while producing this plan. The implementation worker must modify only the files listed by its task.

## File Map and Ownership

- Modify \`src/ui/manager/types.ts\`: manager transport failure types, deep-link input types, and typed message/response contracts.
- Modify \`src/ui/manager/useManagerState.ts\`: object-shaped \`ManagerTransport\` interface, browser transport default, and typed transport-error handling.
- Modify \`src/ui/manager/ManagerApp.tsx\`: optional initial route/deep-link inputs and transport injection; keep page composition unchanged.
- Modify \`src/ui/manager/pages/RulesPage.tsx\` and \`src/ui/manager/rules/RulesOverview.tsx\`: initial workbench deep-link state using the existing editor/confirmation components.
- Modify \`src/ui/manager/pages/GroupsPage.tsx\` and \`src/ui/manager/groups/GroupInspector.tsx\`: pass the non-persistent manager-view fixture to the existing persistent-tabs display component.
- Create \`src/ui/manager/chromeManagerTransport.ts\`: production \`chrome.runtime.sendMessage\` adapter only.
- Modify \`entrypoints/options/App.tsx\` in Task 3, after the workbench app exists: compile-time selection of ordinary options or the development-only workbench host.
- Modify \`wxt.config.ts\` and \`src/env.d.ts\`: build-time workbench flag.
- Create \`src/workbench/types.ts\`, \`url.ts\`, \`scenarios.ts\`, \`fixtureManagerTransport.ts\`, \`WorkbenchHost.tsx\`, \`WorkbenchOptionsApp.tsx\`, and \`markers.ts\`: workbench-only URL, fixtures, controls, host, and markers. The types file also owns the non-persistent manager-view fixture seam and the shared fixture/real evidence-record union.
- Create \`scripts/workbench/contracts.ts\`, \`paths.ts\`, \`lock.ts\`, \`artifacts.ts\`, \`leases.ts\`, \`build.ts\`, \`browser.ts\`, \`readiness.ts\`, \`results.ts\`, \`runner.ts\`, \`cli.ts\`, and \`production-scan.ts\`: Node runner, isolated browser, result, lease, budget, and scan ownership.
- Modify \`package.json\`, \`playwright.config.ts\`, and \`.gitignore\`: commands, bundled Chromium configuration, and ignored run output.
- Create unit tests \`tests/unit/workbench-url.test.ts\`, \`workbench-scenarios.test.ts\`, \`fixture-manager-transport.test.ts\`, \`workbench-artifacts.test.ts\`, \`workbench-leases.test.ts\`, \`workbench-concurrency.test.ts\`, \`production-scan.test.ts\`, \`workbench-runner.test.ts\`, and \`workbench-command-contract.test.ts\`.
- Create test helper \`tests/helpers/workbench-lock-worker.ts\`: two-process lease/artifact lock contention.
- Modify existing manager tests where the transport shape changes: \`tests/component/manager-navigation.test.tsx\`, \`tests/component/manager-shell.test.tsx\`, and \`tests/component/manager-message-router.test.ts\`.
- Create \`tests/component/workbench-host.test.tsx\), \`tests/e2e/workbench.spec.ts\`, \`tests/e2e/extension.spec.ts\`, and \`tests/e2e/popup-smoke.spec.ts\`.
- Create \`docs/agent-development-workbench.md\`: future UI-issue adoption, ownership boundaries, command reference, and release-check boundary.

No other manager, controller, persistence, or feature-storage file owns workbench behavior.

---

### Task 1: Establish the typed transport and build seam

**Files:**

- Modify: \`src/ui/manager/types.ts\`
- Modify: \`src/ui/manager/useManagerState.ts\`
- Modify: \`src/ui/manager/ManagerApp.tsx\`
- Modify: \`src/ui/manager/pages/RulesPage.tsx\`
- Modify: \`src/ui/manager/rules/RulesOverview.tsx\`
- Create: \`src/ui/manager/chromeManagerTransport.ts\`
- Modify: \`wxt.config.ts\`, \`src/env.d.ts\`
- Test: \`tests/component/manager-navigation.test.tsx\`, \`manager-shell.test.tsx\`, \`manager-message-router.test.ts\`

**Interfaces:**

\`\`\`ts
export interface ManagerTransport {
request(message: ManagerMessage): Promise<ManagerResponse>;
}

export type ManagerDeepLink =
| "none"
| "new-rule"
| { kind: "edit-rule" | "confirm-delete"; ruleId: UUID };

export interface PersistentTabsViewFixture {
state: "loading" | "empty" | "populated" | "disabled" | "error";
tabs: readonly string[];
}

export interface ManagerViewFixture {
persistentTabsByGroup: Readonly<Record<UUID, PersistentTabsViewFixture>>;
}

export interface ManagerAppProps {
surface?: "popup" | "options";
transport?: ManagerTransport;
initialRoute?: ManagerRoute;
initialDeepLink?: ManagerDeepLink;
}

export function createChromeManagerTransport(input?: {
sendMessage?: (message: ManagerMessage) => Promise<unknown>;
timeoutMs?: number;
onRecord?: (record: ManagerTransportRecord) => void;
}): ManagerTransport;

export type ManagerTransportRecord =
| {
recordType: "request";
mode: "fixture";
requestId: string;
sequence: number;
scenarioId: string;
message: ManagerMessage;
startedAt: number;
endedAt?: number;
latencyMs: number;
outcome: "resolved" | "rejected";
response?: ManagerResponse;
}
| {
recordType: "request";
mode: "real";
requestId: string;
sequence: number;
workerGeneration?: number;
message: ManagerMessage;
startedAt: number;
endedAt?: number;
latencyMs: number;
outcome: "resolved" | "rejected";
response?: ManagerResponse;
}
| {
recordType: "event";
mode: "fixture" | "real";
source: "page" | "worker" | "transport";
at: number;
name: string;
details: Record<string, string | number | boolean>;
};

export type FixtureCommandRecord = Extract<
ManagerTransportRecord,
{ recordType: "request"; mode: "fixture" }

> ;
> \`\`\`

Extend \`ManagerFailure.error.kind\` with \`"offline" | "transport"\`, and add optional \`code\` and \`field\`. The success shape is \`{ ok: true; configuration; view; viewFixture?: ManagerViewFixture }\`; the fixture is non-persistent display data and is optional in real responses. The Chrome adapter sends only typed manager messages, validates the response, and maps missing responses, \`runtime.lastError\`, timeout, and offline errors to stable typed failures.

- [ ] **Step 1: Write red public-seam tests.** Render \`ManagerApp\` with an object transport, assert the query message, accepted configuration, typed offline state, \`initialRoute: "rules"\` focus, and \`initialDeepLink: "new-rule"\` editor. Assert a router query after a failed command returns the last valid configuration. Assert the shared \`ManagerTransportRecord\` union accepts both fixture and real request/event records without importing workbench code into the production graph.

  \`\`\`ts
  const transport: ManagerTransport = {
  request: vi.fn(async () => ({ ok: true, configuration, view }))
  };
  render(<ManagerApp transport={transport} initialRoute="rules" initialDeepLink="new-rule" />);
  expect(await screen.findByRole("heading", { name: "New rule" })).toBeTruthy();
  expect(transport.request).toHaveBeenCalledWith({ kind: "manager-query" });
  \`\`\`

- [ ] **Step 2: Run the red tests.**

  \`\`\`text
  npm install
  npx vitest run tests/component/manager-navigation.test.tsx tests/component/manager-shell.test.tsx tests/component/manager-message-router.test.ts
  \`\`\`

  Expected: FAIL because the current transport is a function, the app has no initial deep-link inputs, and typed transport failures do not exist.

- [ ] **Step 3: Implement the seam.** Move the current \`chrome.runtime.sendMessage\` code to \`chromeManagerTransport.ts\`; keep the non-extension preview fallback for component tests. Change \`useManagerState\` to call \`transport.request\`, store optional \`result.viewFixture\` beside configuration, and expose it to \`ManagerApp\`. Route deep links through existing Rules components. Do not let \`ManagerApp\` import workbench, repositories, Playwright, or Chrome mutation APIs.

  Configure WXT with \`vite: () => ({ define: { **TABROUTE_WORKBENCH**: JSON.stringify(process.env.TABROUTE_WORKBENCH === "1") } })\` and declare the global boolean in \`src/env.d.ts\`. Leave \`entrypoints/options/App.tsx\` unchanged in this task so this task compiles without the later workbench module. Task 3 owns the false/true options-entry branch after it creates \`WorkbenchOptionsApp.tsx\`.

- [ ] **Step 4: Run green tests and typecheck.**

  \`\`\`text
  npx vitest run tests/component/manager-navigation.test.tsx tests/component/manager-shell.test.tsx tests/component/manager-message-router.test.ts
  npm run typecheck
  \`\`\`

  Expected: PASS, with popup and normal options still using the same manager module.

- [ ] **Step 5: Commit.**

  \`\`\`text
  git add src/ui/manager/types.ts src/ui/manager/useManagerState.ts src/ui/manager/ManagerApp.tsx src/ui/manager/pages/RulesPage.tsx src/ui/manager/rules/RulesOverview.tsx src/ui/manager/chromeManagerTransport.ts wxt.config.ts src/env.d.ts tests/component/manager-navigation.test.tsx tests/component/manager-shell.test.tsx tests/component/manager-message-router.test.ts
  git commit -m "feat: add typed manager transport seam"
  \`\`\`

### Task 2: Add strict URL parsing and deterministic fixture transport

**Files:**

- Create: \`src/workbench/types.ts\`, \`src/workbench/url.ts\`, \`src/workbench/scenarios.ts\`, \`src/workbench/fixtureManagerTransport.ts\`
- Test: \`tests/unit/workbench-url.test.ts\`, \`tests/unit/workbench-scenarios.test.ts\`, \`tests/unit/fixture-manager-transport.test.ts\`

**Interfaces:**

\`\`\`ts
interface WorkbenchUrlState {
workbench: true;
mode: "fixture" | "real";
route: ManagerRoute;
scenarioId: string;
deepLink: ManagerDeepLink;
latencyMs: number;
failure: FixtureFailurePolicy;
}

type FixtureFailurePolicy =
| { mode: "none" }
| { mode: "query" | "command" | "validation" | "offline"; scope: "once" | "persistent" };

interface FixtureManagerControls {
releasePending(): Promise<{
released: Array<{ requestId: string; finalState: "resolved" | "rejected" }>;
}>;
reset(): Promise<void>;
setLatency(milliseconds: number): void;
setFailure(policy: FixtureFailurePolicy): void;
commandLog(): readonly FixtureCommandRecord[];
}

// ManagerTransportRecord, FixtureCommandRecord, ManagerViewFixture, and
// PersistentTabsViewFixture are imported from src/ui/manager/types.ts.

interface ScenarioDefinition {
id: string;
route: ManagerRoute;
deepLink: ManagerDeepLink;
createSeed(): { configuration: Configuration; viewFixture: ManagerViewFixture };
expected: { heading: string; status: "ready" | "loading" | "error"; description: string };
}
\`\`\`

Implement \`parseWorkbenchSearch(search)\` and \`serializeWorkbenchUrl(state)\`. Parsing must reject unknown keys, invalid \`workbench\`, modes, routes, scenarios, deep links, UUIDs, latency outside 0..5000, invalid failure syntax, fixture scenarios in real mode, nonzero real latency, and non-\`none\` real failure. Serialization must use the exact order \`workbench, mode, route, scenario, deep-link, latency, failure\`.

The registry must contain exactly the initial IDs \`wb:default\`, \`wb:empty-groups\`, \`wb:dense-groups\`, \`wb:enabled-group\`, \`wb:disabled-group\`, \`wb:empty-persistent-tabs\`, \`wb:populated-persistent-tabs\`, \`wb:mixed-rules-overview\`, \`wb:new-rule\`, \`wb:edit-rule\`, \`wb:confirmation-overlay\`, \`wb:loading\`, \`wb:slow\`, \`wb:validation-error\`, and \`wb:offline\`. Register \`activity\` as a primary route, not as a new scenario. Each seed uses fixed UUIDs, timestamps, ordering, and labels; it never uses \`Date.now\`, random UUIDs, storage, or Chrome inventory.

\`persistentTabs: never[]\` remains unchanged in \`Configuration\`, and the Zod schema remains unchanged. The \`wb:populated-persistent-tabs\` scenario populates only \`ManagerViewFixture.persistentTabsByGroup[groupId]\` with deterministic display strings. \`ManagerSuccess\` carries this optional \`viewFixture\` field, \`ManagerApp\` passes it to \`GroupsPage\`, and \`GroupInspector\` passes the selected group's view to the existing \`PersistentTabsSection\`. No persistent-tab definition, repository record, storage write, or feature persistence type is added.

- [ ] **Step 1: Write red parser and registry tests.** Cover the canonical URL, all valid values, URL encoding, unknown-parameter rejection, real-mode restrictions, all 15 IDs, deterministic repeated seeds, fixture edit/delete IDs, and absence of unapproved snapshot/diagnostic routes.
- [ ] **Step 2: Run them.**

  \`\`\`text
  npx vitest run tests/unit/workbench-url.test.ts tests/unit/workbench-scenarios.test.ts
  \`\`\`

  Expected: FAIL because the workbench modules do not exist.

- [ ] **Step 3: Write red fixture tests.** Test deterministic queries/mutations, sequence numbers, the shared request/event record union, latency, exact query/command/validation/offline matching, once-policy consumption, reset, state preservation after failure, and exact empty/nonempty \`releasePending()\` results. Assert \`wb:populated-persistent-tabs\` changes only \`viewFixture\`, while \`configuration.persistentTabs\` remains an empty array accepted by the existing schema. Add a source scan proving the adapter has no live Chrome or storage imports.
- [ ] **Step 4: Implement the fixtures.** Use \`createDefaultConfiguration\`, \`createManagedGroup\`, and \`createManagerMessageRouter\` with in-memory repository/controller doubles. Use fixed group/rule IDs and timestamps. Create dense groups, mixed rule statuses, stable edit/confirm IDs, and the typed \`ManagerViewFixture\` display state. Queue \`wb:loading\`'s first query; release in request order; reset all state, log, virtual clock, pending entries, latency, and failure policy. The fixture adapter records request records and returns the accepted configuration plus \`viewFixture\`; it never changes the configuration schema.
- [ ] **Step 5: Run green tests.**

  \`\`\`text
  npx vitest run tests/unit/workbench-url.test.ts tests/unit/workbench-scenarios.test.ts tests/unit/fixture-manager-transport.test.ts
  npm run typecheck
  \`\`\`

  Expected: PASS and deterministic output with no Chrome/storage access.

- [ ] **Step 6: Commit.**

  \`\`\`text
  git add src/workbench/types.ts src/workbench/url.ts src/workbench/scenarios.ts src/workbench/fixtureManagerTransport.ts tests/unit/workbench-url.test.ts tests/unit/workbench-scenarios.test.ts tests/unit/fixture-manager-transport.test.ts
  git commit -m "feat: add deterministic workbench fixtures"
  \`\`\`

### Task 3: Add the workbench host and initial deep links

**Files:**

- Create: \`src/workbench/markers.ts\`, \`src/workbench/WorkbenchHost.tsx\`, \`src/workbench/WorkbenchOptionsApp.tsx\`
- Modify: \`entrypoints/options/App.tsx\`, \`src/ui/manager/ManagerApp.tsx\`, \`src/ui/manager/pages/RulesPage.tsx\`, \`src/ui/manager/rules/RulesOverview.tsx\`, \`src/ui/manager/pages/GroupsPage.tsx\`, \`src/ui/manager/groups/GroupInspector.tsx\`, \`src/ui/manager/manager.css\`
- Test: \`tests/component/workbench-host.test.tsx\`

**Interfaces:**

\`\`\`ts
interface WorkbenchHostProps {
state: WorkbenchUrlState;
fixture?: { transport: ManagerTransport; controls: FixtureManagerControls };
real: ManagerTransport;
records: readonly ManagerTransportRecord[];
children: React.ReactNode;
onStateChange(next: WorkbenchUrlState): void;
}
\`\`\`

The host emits only in the workbench graph: \`data-workbench-marker="TABROUTE_DEV_WORKBENCH_V1"\`, \`data-workbench-status="manager-pending" | "manager-ready" | "manager-error"\`, \`data-workbench-control\`, \`tabrouteFixtureRegistryV1\`, and a payload containing mode, scenario, route, and transport status. It renders the supplied shared fixture/real \`ManagerTransportRecord\` list as the command/event log. Every control has an accessible label and stable selector: mode, scenario, route, deep link/UUID, latency, failure mode/scope, Release pending response, Reset, command log, screenshot status, and result status.

- [ ] **Step 1: Write red host tests.** Assert controls, exact 520 × 600 preview metadata, \`history.replaceState\` URL synchronization, loading marker/release behavior, deep-link editor/dialog, route focus, and absence of workbench markers in popup/normal options.
- [ ] **Step 2: Run red tests.**

  \`\`\`text
  npx vitest run tests/component/workbench-host.test.tsx tests/component/manager-navigation.test.tsx
  \`\`\`

  Expected: FAIL because the host and markers do not exist.

- [ ] **Step 3: Implement the host.** Keep controls outside a \`.workbench-preview\` fixed at 520 by 600 CSS pixels. Do not inject CSS into the manager or alter \`.manager-page-scroll\`. Parse and validate every URL update before \`history.replaceState\`. Use fixture controls only through \`FixtureManagerControls\`; real mode has no fixture release/latency/failure control. Create the real adapter with its \`onRecord\` callback, merge fixture request records and real request/event records into the shared list, and pass that list to the host and result writer. Mark ready only after the first query settles, and keep loading pending until release.
- [ ] **Step 4: Wire deep links and the view fixture.** Add optional initial route/deep-link props to \`ManagerApp\`, pass them to existing Rules editor/overview logic, pass \`viewFixture\` through \`GroupsPage\` to the selected \`GroupInspector\`, and pass the selected group's \`PersistentTabsViewFixture\` to the existing \`PersistentTabsSection\`. Add no duplicate page, dialog, persistence, or persistent-tab definition implementation.
- [ ] **Step 5: Run green tests and typecheck.**

  \`\`\`text
  npx vitest run tests/component/workbench-host.test.tsx tests/component/manager-navigation.test.tsx tests/component/manager-shell.test.tsx tests/component/options-editor.test.tsx
  npm run typecheck
  \`\`\`

  Expected: PASS; production pages contain no host controls.

- [ ] **Step 6: Commit.**

  \`\`\`text
  git add src/workbench/markers.ts src/workbench/WorkbenchHost.tsx src/workbench/WorkbenchOptionsApp.tsx entrypoints/options/App.tsx src/ui/manager/ManagerApp.tsx src/ui/manager/pages/RulesPage.tsx src/ui/manager/rules/RulesOverview.tsx src/ui/manager/pages/GroupsPage.tsx src/ui/manager/groups/GroupInspector.tsx src/ui/manager/manager.css tests/component/workbench-host.test.tsx tests/component/manager-navigation.test.tsx
  git commit -m "feat: add workbench manager host"
  \`\`\`

### Task 4: Add production exclusion, leases, cleanup, and artifact budgets

**Files:**

- Create: \`scripts/workbench/contracts.ts\`, \`scripts/workbench/paths.ts\`, \`scripts/workbench/lock.ts\`, \`scripts/workbench/artifacts.ts\`, \`scripts/workbench/leases.ts\`, \`scripts/workbench/production-scan.ts\`
- Modify: \`wxt.config.ts\`, \`package.json\`, \`.gitignore\`
- Test: \`tests/unit/workbench-artifacts.test.ts\`, \`tests/unit/workbench-leases.test.ts\`, \`tests/unit/workbench-concurrency.test.ts\`, \`tests/unit/production-scan.test.ts\`, \`tests/helpers/workbench-lock-worker.ts\`

**Interfaces:**

\`\`\`ts
type WorkbenchErrorCode =
| "WORKBENCH_ARGUMENT"
| "WORKBENCH_WORKER_TIMEOUT"
| "WORKBENCH_MANAGER_TIMEOUT"
| "WORKBENCH_CLEANUP_FAILED"
| "WORKBENCH_CAPACITY"
| "WORKBENCH_ARTIFACT_LIMIT";

interface RunPaths {
runId: string; worktreePath: string; buildPath: string;
profilePath: string; artifactPath: string;
}

interface ArtifactStore {
write(relativePath: string, bytes: Uint8Array, kind: ArtifactKind): Promise<void>;
finalize(status: "completed" | "failed" | "abandoned"): Promise<void>;
}

interface LeaseRecord {
runId: string; pid: number; startedAt: string; heartbeat: string;
profilePath: string; status: "active" | "abandoned" | "completed";
}

interface CrossProcessLock {
acquire(): Promise<{ release(): Promise<void> }>;
withLock<T>(operation: () => Promise<T>): Promise<T>;
}

const REQUIRED_METADATA_RESERVATION_BYTES = 2 * 1024 * 1024;
const REQUIRED_METADATA_CAPS = {
maxCommandRecords: 1000,
maxEventRecords: 1000,
maxAssertions: 1000,
maxScreenshotPaths: 500,
maxStringBytes: 4096,
maxUrlBytes: 16384,
maxErrorBytes: 8192
} as const;
\`\`\`

Use constants 50 MiB active, 200 MiB global, 5 MiB text logs, 20 terminal runs, and seven days. \`terminalAt\` is used only for terminal-run age/count pruning; \`capturedAt\` is used only for optional evidence eviction within video, trace, and screenshot categories. Enforce budgets before every log/screenshot/trace/video/result/error write. Prune old terminal runs, then terminal count, then affected-run optional evidence in video/trace/screenshot order, then global terminal/optional evidence. Sort terminal runs by \`terminalAt\`, then \`runId\`; sort optional evidence by \`capturedAt\`, then \`runId\`, then \`relativePath\`. Rotate text logs to 5 MiB. Never evict lease/status/result/error metadata.

Reserve exactly \`REQUIRED_METADATA_RESERVATION_BYTES\` in both the affected-run and global budgets for the combined required metadata. Before writing \`results.json\`, cap every string/array using \`REQUIRED_METADATA_CAPS\`, encode the capped object as UTF-8, and reject it with \`WORKBENCH_ARTIFACT_LIMIT\` if its byte length exceeds the reservation. Required metadata includes \`lease.json\`, status, result, error, run/profile/build paths, cleanup status, readiness timestamps, request/event records, assertions, screenshot paths, and error details. Boundary tests must cover reservation minus one byte, exactly the reservation, and reservation plus one byte after JSON encoding.

Leases contain \`runId\`, \`pid\`, \`startedAt\`, \`heartbeat\`, \`profilePath\`, and status. Create before Chromium, heartbeat every five seconds, reap only heartbeat older than two minutes with a dead PID, and use the ten-minute conservative rule when liveness is unavailable. Reaping marks \`abandoned\`. Cleanup retries exactly after 250, 500, and 1000 ms; the third failure returns \`WORKBENCH_CLEANUP_FAILED\` with the retained path. Count non-stale active leases and refuse the ninth with \`WORKBENCH_CAPACITY\`.

All lease-capacity and artifact-retention operations use one cross-process lock under \`.workbench/artifacts/.lock\`. Acquire it with atomic exclusive file creation (\`fs.open(lockPath, "wx")\`), write owner PID/run ID/heartbeat, refresh while the operation runs, and recover only stale locks using the same two-minute dead-PID or ten-minute unavailable-liveness rule. Hold the lock across reap/count/create and across budget-size/prune/write. A failed lock acquisition has a bounded retry and returns \`WORKBENCH_CAPACITY\` or \`WORKBENCH_ARTIFACT_LIMIT\` without a partial write.

The production scan accepts an explicit \`buildPath: string\` and recursively checks every asset below that path for exact UTF-8 markers \`TABROUTE_DEV_WORKBENCH_V1\`, \`data-workbench-control\`, \`tabrouteFixtureRegistryV1\`, and regex \`wb:[a-z0-9-]+\`. It separately parses the manifest and rejects workbench entrypoint keys/names/HTML paths and HTML basename \`workbench\`. It also checks Chrome MV3, \`incognito: "not_allowed"\`, and the approved permission/command surface. Ordinary \`ChromeManagerTransport\`, \`default\`, \`loading\`, and \`offline\` text is allowed.

- [ ] **Step 1: Write red tests** for terminalAt versus capturedAt ordering, all pruning order/budget/rotation rules, required-metadata reservation boundaries and field caps, stale-lock recovery, concurrent eighth/ninth lease creation, concurrent global writes, concurrent pruning/reaping, marker/manifest/HTML rules, and atomic no-partial-write behavior. Spawn two Node processes through \`tests/helpers/workbench-lock-worker.ts\` against the same lock: with seven active leases, exactly one contender creates lease eight and the other returns \`WORKBENCH_CAPACITY\`; concurrent artifact writes serialize, preserve required metadata, and apply one deterministic prune order.
- [ ] **Step 2: Run red tests.**

  \`\`\`text
  npx vitest run tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts
  \`\`\`

  Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the modules** with injected clock, process inspector, sleep, filesystem, and cleanup functions. Validate all paths before cleanup or replacement; never delete an unresolved workspace root. Use the exclusive lock for every cross-process lease/artifact critical section, and make stale-lock recovery explicit and bounded.
- [ ] **Step 4: Add cross-platform commands and ignore rules.** Use \`tsx\`/Node \`process.env\`, not shell-specific \`set\` syntax. Add these exact package scripts and keep \`test:e2e\`:

  \`\`\`json
  {
  "build:workbench": "tsx scripts/workbench/cli.ts build-workbench",
  "workbench": "tsx scripts/workbench/cli.ts workbench --mode fixture",
  "workbench:real": "tsx scripts/workbench/cli.ts workbench --mode real",
  "test:workbench": "tsx scripts/workbench/cli.ts test-workbench",
  "test:extension": "tsx scripts/workbench/cli.ts test-extension",
  "smoke:popup": "tsx scripts/workbench/cli.ts smoke-popup"
  }
  \`\`\`

  Set \`outDir: process.env.TABROUTE_WXT_OUT_DIR ?? ".output"\` in \`wxt.config.ts\`; the runner supplies a unique absolute parent path. Ignore \`.workbench/artifacts/\` and \`.workbench/tmp/\`, not source tests or plans.

- [ ] **Step 5: Run green tests.**

  \`\`\`text
  npx vitest run tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts
  npm run typecheck
  \`\`\`

  Expected: PASS with deterministic ordering and bounded cleanup.

- [ ] **Step 6: Commit.**

  \`\`\`text
  git add scripts/workbench/contracts.ts scripts/workbench/paths.ts scripts/workbench/lock.ts scripts/workbench/artifacts.ts scripts/workbench/leases.ts scripts/workbench/production-scan.ts wxt.config.ts package.json .gitignore tests/unit/workbench-artifacts.test.ts tests/unit/workbench-leases.test.ts tests/unit/workbench-concurrency.test.ts tests/unit/production-scan.test.ts tests/helpers/workbench-lock-worker.ts
  git commit -m "feat: add workbench isolation and artifact bounds"
  \`\`\`

### Task 5: Add the isolated Chromium runner and readiness protocol

**Files:**

- Create: \`scripts/workbench/build.ts\`, \`scripts/workbench/browser.ts\`, \`scripts/workbench/readiness.ts\`, \`scripts/workbench/results.ts\`, \`scripts/workbench/runner.ts\`, \`scripts/workbench/cli.ts\`
- Modify: \`playwright.config.ts\`
- Test: \`tests/unit/workbench-runner.test.ts\`, \`tests/e2e/workbench.spec.ts\`

**Interfaces:**

\`\`\`ts
async function launchExtensionSession(input: {
buildPath: string; profilePath: string; headless: boolean;
onEvent(event: RunnerEvent): Promise<void>;
}): Promise<ExtensionSession>;

async function buildExtension(input: {
worktreePath: string;
runId: string;
graph: "workbench" | "production";
}): Promise<{ graph: "workbench" | "production"; outDir: string; buildPath: string }>;

interface ExtensionSession {
context: BrowserContext;
browser: Browser;
extensionId: string;
workerGenerations: Array<{ id: string; discoveredAt: string }>;
openExtensionPage(path: string): Promise<Page>;
restartWorker(): Promise<{ terminatedTargetId: string; awakenedTargetId: string }>;
close(): Promise<void>;
}

interface RunResult {
ok: boolean; runId: string; worktreePath: string; buildPath: string;
profilePath: string; extensionId?: string; mode: "fixture" | "real";
url: string; scenario: string; route: ManagerRoute; deepLink: ManagerDeepLink;
commandRecords: readonly ManagerTransportRecord[];
readiness: { workerDiscoveredAt?: string; managerQuerySettledAt?: string };
screenshotPaths: readonly string[]; assertions: readonly RunAssertion[];
lease: LeaseRecord; cleanup: { profileRemoved: boolean; retainedPath?: string };
error?: { code: WorkbenchErrorCode; phase?: string; message?: string };
}
\`\`\`

Use \`chromium.launchPersistentContext(profilePath, { channel: "chromium", headless, args: ["--disable-extensions-except=<buildPath>", "--load-extension=<buildPath>"] })\` with Playwright's bundled Chromium. The explicit \`channel: "chromium"\` is required for headless extension startup. Never set \`executablePath\`, use a user profile, connect to an existing browser, use a remote debugging endpoint, open \`chrome://extensions\`, or use toolbar interaction.

Discover an existing \`context.serviceWorkers()\` worker or wait for \`context.waitForEvent("serviceworker")\` for 15,000 ms. Parse and validate \`chrome-extension://<id>/...\`; record the ID only in the result. Open \`options.html\` after discovery. The first manager query has a separate 5,000 ms deadline. Retry only the exact case-insensitive \`receiving end does not exist\` text every 250 ms. A worker timeout returns \`{ ok: false, code: "WORKBENCH_WORKER_TIMEOUT", phase: "worker" }\`; a manager timeout returns \`{ ok: false, code: "WORKBENCH_MANAGER_TIMEOUT", phase: "manager-query", workerDiscoveredAt }\`. A loading fixture remains pending until its typed release.

- [ ] **Step 1: Write red unit seams** for current-worktree refusal, unique run-specific WXT output paths, worker URL parsing, invalid origin, \`channel: "chromium"\` with \`headless: true\`, separate deadlines, exact retry text, canonical URL, result-path printing, cleanup on failure, and worker generations. Add a headless Playwright worker-discovery test that launches the bundled Chromium path in the default headless mode and proves the service-worker target is discoverable before opening the options page.
- [ ] **Step 2: Run the red runner tests.**

  \`\`\`text
  npx vitest run tests/unit/workbench-runner.test.ts
  \`\`\`

  Expected: FAIL because the runner modules do not exist. If split into browser/readiness files, run both exact files with the same assertions.

- [ ] **Step 3: Implement build and lifecycle.** Resolve and verify \`process.cwd()\` as the current worktree. For each run, set \`outDir = <worktree>/.workbench/tmp/<run-id>/<graph>\` through \`TABROUTE_WXT_OUT_DIR\`, run WXT, and require \`buildPath = <outDir>/chrome-mv3\`. Return that exact \`buildPath\` to both launcher and scanner; never point parallel runs at \`.output/chrome-mv3\`. Create a unique OS-temp profile, create the lease, launch persistent Chromium, capture page/worker console and error events, and write bounded \`results.json\` with all \`RunResult\` fields. Build the exact canonical URL with the derived ID and default fixture query. \`npm run workbench\` uses fixture mode, \`wb:default\`, and keeps the session available for inspection; its noninteractive test form accepts \`--once\` and closes after evidence.
- [ ] **Step 4: Implement restart with a target probe, not an event dependency.** Get \`browser = context.browser()\`; create \`cdp = await browser.newBrowserCDPSession()\`; call \`Target.getTargets\`; select the extension \`service_worker\` target; call \`Target.closeTarget({ targetId })\`; poll \`Target.getTargets\` until that target ID is absent, with a 5,000 ms termination deadline. Then send one typed \`manager-query\` from the extension page, retry only \`receiving end does not exist\` at 250 ms cadence until a separate 5,000 ms wake deadline, and poll \`Target.getTargets\` for a new extension service-worker target ID. Record the old/new target IDs as generations. A termination or wake deadline failure returns \`WORKBENCH_WORKER_TIMEOUT\` with phase \`restart-termination\` or \`restart-wake\`; it never waits indefinitely for \`context.waitForEvent("serviceworker")\`. Do not use extension-management UI.
- [ ] **Step 5: Configure Playwright and add browser tests.** Set \`testDir: "tests/e2e"\`, \`browserName: "chromium"\`, and no executable path. Open the default workbench URL, wait for markers, assert computed 520/600 dimensions, capture a screenshot, assert result metadata has the same run and derived extension IDs, and run a named headless worker-discovery test with the exact 15,000 ms deadline.
- [ ] **Step 6: Run the first browser pass.**

  \`\`\`text
  npx playwright test tests/e2e/workbench.spec.ts --grep "default scenario"
  \`\`\`

  Expected: PASS after implementation, with a fresh profile removed and a result path printed.

- [ ] **Step 7: Commit.**

  \`\`\`text
  git add scripts/workbench/build.ts scripts/workbench/browser.ts scripts/workbench/readiness.ts scripts/workbench/results.ts scripts/workbench/runner.ts scripts/workbench/cli.ts playwright.config.ts tests/unit/workbench-runner.test.ts tests/e2e/workbench.spec.ts
  git commit -m "feat: add isolated workbench browser runner"
  \`\`\`

### Task 6: Complete fixture browser coverage and evidence

**Files:** Modify \`tests/e2e/workbench.spec.ts\`, \`src/workbench/WorkbenchHost.tsx\`, \`src/workbench/scenarios.ts\`, \`scripts/workbench/results.ts\`, and \`scripts/workbench/artifacts.ts\`.

- [ ] **Step 1: Add red parameterized tests** for all 15 scenarios, route navigation for Groups/Rules/Activity/Settings, deep links, route focus, header/navigation outside the feature scroller, intended Groups navigator/inspector and manager body scrolling, overlay focus/Tab trap/Escape/focus restoration, exact latency/failure/reset controls, command/event log order/error/latency for both fixture and real discriminants, Release pending response, exact 520 × 600 dimensions, and screenshot/result metadata.
- [ ] **Step 2: Run the fixture suite.**

  \`\`\`text
  npm run test:workbench
  \`\`\`

  Expected: FAIL for any missing public scenario/control/focus/scroll/evidence contract; still write bounded failure results and clean the profile.

- [ ] **Step 3: Implement only missing public contracts.** Add named expected behavior to registry data, not scenario-specific markup. Keep loading pending until release and ready only after settle. Use only accessible labels, \`data-workbench-control\`, \`data-route-focus\`, and public roles/text in Playwright; do not inspect React state or private hooks.
- [ ] **Step 4: Run green fixture coverage and style checks.**

  \`\`\`text
  npm run test:workbench
  npm run format:check
  npm run lint
  \`\`\`

  Expected: PASS with one bounded run ID per evidence set and no artifact budget violation.

- [ ] **Step 5: Commit.**

  \`\`\`text
  git add tests/e2e/workbench.spec.ts src/workbench/WorkbenchHost.tsx src/workbench/scenarios.ts scripts/workbench/results.ts scripts/workbench/artifacts.ts
  git commit -m "test: cover workbench fixture scenarios"
  \`\`\`

### Task 7: Add real mode, worker restart, production gate, and popup smoke

**Files:**

- Create: \`tests/e2e/extension.spec.ts\`, \`tests/e2e/popup-smoke.spec.ts\`, \`tests/unit/workbench-command-contract.test.ts\`
- Modify: \`scripts/workbench/runner.ts\`, \`scripts/workbench/cli.ts\`, \`scripts/workbench/production-scan.ts\`, \`package.json\`

**Interfaces:**

\`\`\`ts
interface ProductionGateResult {
workbenchBuildPath: string;
productionBuildPath: string;
productionScan: { ok: true };
}

function runRealExtensionAssertions(input: {
buildPath: string;
}): Promise<void>;
\`\`\`

- [ ] **Step 1: Write red tests** for real options query/command through the actual worker, accepted-state responses, invalid-command preservation, worker restart and second query, popup/options shared \`ManagerApp\`, exact dimensions, profile isolation, distinct run/profile/artifact paths, two concurrent builds with distinct \`.workbench/tmp/<run-id>/<graph>/chrome-mv3\` paths, distinct derived extension IDs, and no fixture seeding in real mode.
- [ ] **Step 2: Run red tests.**

  \`\`\`text
  npx vitest run tests/unit/workbench-command-contract.test.ts
  npx playwright test tests/e2e/extension.spec.ts tests/e2e/popup-smoke.spec.ts
  \`\`\`

  Expected: FAIL until real assertions, restart, and popup smoke exist.

- [ ] **Step 3: Implement real mode.** \`npm run workbench:real\` uses the same isolated persistent runner with \`mode=real\`, only \`wb:default\`, no fixture controls, and actual \`ChromeManagerTransport\`, worker, repository, controller, and Action Engine. Record shared \`ManagerTransportRecord\` request/event records from page, worker, and transport. Real \`RunResult.commandRecords\` is the shared union, never \`FixtureCommandRecord[]\`.
- [ ] **Step 4: Add the positive/negative production gate.** \`npm run test:extension\` first builds a workbench graph to \`.workbench/tmp/<run-id>/workbench/chrome-mv3\` and asserts all required workbench markers exist. It then builds a separate production graph to \`.workbench/tmp/<run-id>/production/chrome-mv3\`, asserts no required marker or \`wb:\` ID exists anywhere in that full tree, parses its manifest/HTML, and only then runs real extension tests against that exact production \`buildPath\`. Do not run real tests against the workbench graph. Keep the existing Chrome MV3, approved permissions, command surface, and \`incognito: "not_allowed"\` checks.
- [ ] **Step 5: Implement popup smoke.** Open the actual generated popup entry point in the isolated profile, do not use workbench controls or fixture data, assert shared \`ManagerApp\`, Groups, \`data-manager-viewport="520x600"\`, one screenshot, and machine-readable result.
- [ ] **Step 6: Run all gates.**

  \`\`\`text
  npm run build
  npm run test:extension
  npm run smoke:popup
  npm run workbench:real -- --once
  \`\`\`

  Expected: PASS with separate production, real lifecycle, and popup results; required stable error codes on failure.

- [ ] **Step 7: Commit.**

  \`\`\`text
  git add tests/e2e/extension.spec.ts tests/e2e/popup-smoke.spec.ts tests/unit/workbench-command-contract.test.ts scripts/workbench/runner.ts scripts/workbench/cli.ts scripts/workbench/production-scan.ts package.json
  git commit -m "test: add real extension and popup gates"
  \`\`\`

### Task 8: Document adoption and finish the quality matrix

**Files:** Create \`docs/agent-development-workbench.md\`; modify command/test files only for failures proven by the matrix; test \`tests/unit/workbench-command-contract.test.ts\`.

- [ ] **Step 0: Record the implementation base before the first implementation commit.**

  \`\`\`powershell
  New-Item -ItemType Directory -Force .workbench | Out-Null
  (git rev-parse HEAD).Trim() | Set-Content -NoNewline .workbench/implementation-base-sha
  \`\`\`

  Expected: \`.workbench/implementation-base-sha\` contains one full commit SHA and remains the fixed review base for the complete implementation.

- [ ] **Step 1: Write the documentation assertion** for the five commands, \`ManagerApp\`, \`ManagerTransport\`, all five stable budget/readiness/capacity codes, 520 × 600, future UI issue checklist, feature-storage ownership, next-enabling-task order, no-Linear boundary, and final branded-Chrome manual release check.
- [ ] **Step 2: Run it red.**

  \`\`\`text
  npx vitest run tests/unit/workbench-command-contract.test.ts
  \`\`\`

  Expected: FAIL until the adoption document is present.

- [ ] **Step 3: Write the document.** Include the exact canonical URL, fixture/real responsibilities, 15 scenarios, evidence and artifact rules, no-user-Chrome rule, future issue contract (fixture, public Vitest, Workbench Playwright, screenshot, production scan when needed), removal path, explicit non-goals, and the rule that feature issues own Sync/Local/Activity/Undo/snapshot storage tests.
- [ ] **Step 4: Run the complete required matrix.**

  \`\`\`text
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
  \`\`\`

  Expected: all PASS; production output has no markers; fresh profiles are cleaned; evidence stays within budgets; no new feature storage exists.

- [ ] **Step 5: Perform scoped review from the recorded implementation base.**

  \`\`\`powershell
  $baseSha = (Get-Content .workbench/implementation-base-sha -Raw).Trim()
  git diff --check "$baseSha..HEAD"
  git status --short
  git diff --stat "$baseSha..HEAD"
  rg -n "chrome\\.(tabs|tabGroups)\\.(group|move|ungroup|remove|update)\\s*\\(" src/workbench src/ui entrypoints
  $latestResult = Get-ChildItem .workbench/artifacts -Recurse -Filter results.json | Sort-Object LastWriteTime | Select-Object -Last 1
  $productionBuildPath = (Get-Content $latestResult.FullName -Raw | ConvertFrom-Json).buildPath
  rg -n "TABROUTE_DEV_WORKBENCH_V1|data-workbench-control|tabrouteFixtureRegistryV1|wb:[a-z0-9-]+" $productionBuildPath
  \`\`\`

  Expected: mutation scan finds no UI/workbench calls; the production marker scan finds no matches in the recorded production build path; \`$baseSha..HEAD\` contains only planned files; status is clean after commit.

- [ ] **Step 6: Commit.**

  \`\`\`text
  git add docs/agent-development-workbench.md tests/unit/workbench-command-contract.test.ts package.json scripts/workbench/cli.ts scripts/workbench/runner.ts scripts/workbench/production-scan.ts tests/e2e/workbench.spec.ts tests/e2e/extension.spec.ts tests/e2e/popup-smoke.spec.ts
  git commit -m "docs: document workbench adoption contract"
  \`\`\`

## Final Verification and Handoff

The build helper sets TABROUTE_WORKBENCH=1 for the workbench graph and TABROUTE_WORKBENCH=0 for the production graph, while each graph still receives its own absolute TABROUTE_WXT_OUT_DIR. The production gate must build and scan both graphs before real assertions run.

Before declaring implementation complete, verify: one \`ManagerApp\); one object-shaped transport seam; deterministic fixture IDs/times/commands/delay/failures/reset/release; strict canonical URL; all 15 scenarios; browser-observable 520 × 600/focus/scroll/overlay behavior; current-worktree build; fresh persistent profile; derived ID; worker generations; readiness deadlines; leases, capacity, cleanup, log rotation, evidence eviction, and result paths; no user Chrome, fixed ID, \`chrome://extensions\`, toolbar, Computer Use, manual storage, or server; real messaging/restart/options/popup/profile tests; complete production scan; all five npm commands; future UI adoption and feature-storage boundaries; and the single final branded-Chrome manual release check. If a criterion fails, correct its owning task and rerun its focused tests plus this matrix. Do not add feature persistence or broaden Chrome API access to make a workbench test pass.
