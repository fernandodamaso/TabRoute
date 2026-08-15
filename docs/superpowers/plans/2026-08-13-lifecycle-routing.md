# FDM-593 Lifecycle Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic routing safe under real Chrome event sequences and Manifest V3 worker suspension: extension echoes never become manual overrides, genuine user placement survives until restart, and group-removal evidence is settled before any UUID is attached or closed.

**Architecture:** Keep the existing Action Engine as the only Chrome mutation path. Persist one typed `RuntimeSession` in `storage.session`. Classify every Chrome event against operation guards and pending group-removal records before reconciliation. Rebuild associations from fresh inventory; never persist Chrome `tabId`/`groupId`/`windowId` as durable identity.

**Tech Stack:** TypeScript 6, WXT 0.21 Chrome Manifest V3, Vitest 4, Playwright 1.62 isolated Chromium via the existing workbench runner.

## Global Constraints

- Target Google Chrome 121+ and Manifest V3 only. Do not add Firefox, Edge, Safari, or Manifest V2 paths.
- Never read, classify, mutate, snapshot, or restore Incognito tabs or windows.
- Never add desktop notifications, telemetry, analytics, accounts, or remotely hosted code.
- Use extension-owned UUIDs as durable identity. Chrome `tabId`, `groupId`, and `windowId` are runtime associations only.
- Treat service-worker globals as caches. Recoverable lifecycle state belongs in `storage.session`.
- Use `chrome.alarms` for delayed group-settlement recovery; do not depend on JavaScript timers surviving worker termination or on `runtime.onSuspend`.
- Only `src/chrome/liveChromePort.ts` and `src/actions/executeActionPlan.ts` may call Chrome mutation methods.
- Preserve manual tab placement until Chrome restart. Persistent-tab repair is out of scope for this issue.
- Treat Chrome shared groups as unmanaged and never automatically mutate their presentation or member tabs.
- Keep mutation guards active through their complete correlated event footprint and verified quiet settlement. A contradictory fresh-state user change must retire the guard and remain manual intent.
- Operation-guard quiet period is exactly 750 ms. Hard settlement deadline is exactly 5_000 ms after mutation start. Elapsed time alone never proves success.
- `WINDOW_ID_NONE` and non-normal windows are never home, fallback, or ownership candidates.
- Out of scope: persistent-tab repair, full-window shutdown semantics, Sync generation transport, snapshot restoration, Activity/Undo, and UI polish.
- Use test-driven development for every behavior change and commit after every task passes its specified gate.
- Do not attach to the user's Chrome profile. Isolated Chromium e2e uses the workbench runner.
- Do not implement `moveManagedGroup`, duplicate close, snapshot, or startup restore actions. Current `ActionPlan` remains `routeToGroup | routeToFallback | ungroup`.
- Existing `handleTabUpdated` callers must keep working: map that method onto `handleChromeEvent({ kind: "tabUpdated", ... })`.

## File Map and Ownership

- Modify `src/domain/types.ts`: `ChromeAssociation` observation fields plus `OperationGuard`, `ManualOverride`, `PendingGroupRemoval`, `TabObservation`, `RuntimeSession`, `ChromeEventHint`.
- Modify `src/domain/ids.ts` if a branded `BrowserSessionId` / `ActionId` helper is needed; otherwise brand at the call site with existing `createUuid`.
- Create `src/state/runtimeSession.ts`: empty-session factory, parse/validate, `transferReplacedTab`, `purgeClosedTab`, `scrubRuntimeState`.
- Modify `src/state/sessionRepository.ts`: load/save typed `RuntimeSession`; keep association helpers as wrappers.
- Modify `src/chrome/reconstructAssociations.ts`: populate `observedTitle` and `observedMemberUrls`; continue ignoring `shared: true`.
- Create `src/actions/operationGuards.ts`: `GUARD_QUIET_MS`, `GUARD_HARD_MS`, `buildExpectedFootprint`, `classifyGuardedEvent`, `settleOperationGuards`.
- Create `src/actions/retryPolicy.ts`: `classifyMutationError`, `executeWithRetry`.
- Modify `src/actions/executeActionPlan.ts` and `src/actions/types.ts`: write executing/settling guards; retry transient drag errors.
- Create `src/controller/eventClassifier.ts`: loading hold, activation recency, shared-group hold, `WINDOW_ID_NONE` exclusion, override writes.
- Create `src/groups/groupLifecycle.ts`: pending removal, unambiguous cross-window reconstruct, ambiguous leave-unattached, settled-absence intentional-close marker.
- Modify `src/controller/controller.ts`: `handleChromeEvent`, coalescing queue, worker-wake settlement, override-aware `reconcileTab`.
- Modify `entrypoints/background.ts`: register the full event set; map `WINDOW_ID_NONE`; call worker-wake on startup.
- Modify `tests/unit/association-reconstruction.test.ts` for the extended association shape.
- Create focused tests listed per task.
- Create `tests/e2e/lifecycle.spec.ts` using the isolated Chromium production session helper from `tests/e2e/extension.spec.ts`.

---

### Task 1: Typed session runtime, replacement transfer, and scrub

**Files:**

- Modify: `src/domain/types.ts`
- Create: `src/state/runtimeSession.ts`
- Modify: `src/state/sessionRepository.ts`
- Modify: `src/chrome/reconstructAssociations.ts`
- Modify: `tests/unit/association-reconstruction.test.ts`
- Create: `tests/unit/runtime-session.test.ts`

**Interfaces:**

```ts
export type BrowserSessionId = string & {
  readonly __brand: "BrowserSessionId";
};
export type ActionId = string & { readonly __brand: "ActionId" };

export type GuardEventKind =
  | "tabCreated"
  | "tabUpdated"
  | "tabActivated"
  | "tabMoved"
  | "tabAttached"
  | "tabDetached"
  | "tabRemoved"
  | "tabReplaced"
  | "groupCreated"
  | "groupUpdated"
  | "groupMoved"
  | "groupRemoved";

export type GuardPostcondition =
  | {
      kind: "tabPlacement";
      tabIds: number[];
      windowId: number;
      chromeGroupId?: number;
      ungrouped?: true;
    }
  | {
      kind: "managedGroupState";
      managedGroupId: UUID;
      windowId?: number;
      title?: string;
      color?: ChromeGroupColor;
      collapsed?: boolean;
    };

export interface OperationGuard {
  id: UUID;
  browserSessionId: BrowserSessionId;
  actionId: ActionId;
  operation: "assignTabsToManagedGroup" | "ungroupTabs";
  phase: "executing" | "settling";
  tabIds: number[];
  chromeGroupIds: number[];
  expectedEventKinds: GuardEventKind[];
  seenEventKinds: GuardEventKind[];
  postcondition?: GuardPostcondition;
  startedAt: number;
  verifiedAt?: number;
  settleAfter?: number;
  expiresAt: number;
}

export type ManualPlacement =
  | { kind: "managedGroup"; managedGroupId: UUID }
  | { kind: "ungrouped" }
  | { kind: "leaveWherePlaced" };

export interface ManualOverride {
  tabId: number;
  placement: ManualPlacement;
  createdAt: number;
}

export interface TabObservation {
  tabId: number;
  firstObservedAt: number;
  firstObservedOrdinal: number;
  lastObservedUrl: string;
}

export interface PendingGroupRemoval {
  managedGroupId: UUID;
  removedChromeGroupId: number;
  oldWindowId: number;
  memberTabIds: number[];
  memberUrls: string[];
  renderedTitle: string;
  startedAt: number;
  settleAfter: number;
}

export interface ChromeAssociation {
  managedGroupId: UUID;
  chromeGroupId: number;
  chromeWindowId: number;
  observedTitle: string;
  observedMemberUrls: string[];
  observedAt: number;
}

export interface RuntimeSession {
  schemaVersion: 1;
  browserSessionId: BrowserSessionId;
  nextObservationOrdinal: number;
  tabObservations: TabObservation[];
  manualOverrides: Record<string, ManualOverride>;
  intentionallyClosedGroupIds: UUID[];
  operationGuards: OperationGuard[];
  pendingGroupRemovals: PendingGroupRemoval[];
  lastFocusedNormalWindowId?: number;
  associations: ChromeAssociation[];
}

export type ChromeEventHint =
  | { kind: "tabCreated"; tabId: number }
  | {
      kind: "tabUpdated";
      tabId: number;
      urlChanged: boolean;
      groupChanged: boolean;
      pinnedChanged: boolean;
    }
  | { kind: "tabActivated"; tabId: number; windowId: number }
  | {
      kind: "tabMoved";
      tabId: number;
      windowId: number;
      fromIndex: number;
      toIndex: number;
    }
  | {
      kind: "tabAttached";
      tabId: number;
      newWindowId: number;
      newPosition: number;
    }
  | {
      kind: "tabDetached";
      tabId: number;
      oldWindowId: number;
      oldPosition: number;
    }
  | {
      kind: "tabRemoved";
      tabId: number;
      windowId: number;
      isWindowClosing: boolean;
    }
  | { kind: "tabReplaced"; addedTabId: number; removedTabId: number }
  | {
      kind: "groupCreated" | "groupUpdated" | "groupMoved" | "groupRemoved";
      group: ChromeGroupSnapshot;
    }
  | {
      kind: "windowFocusChanged";
      focus: { kind: "none" } | { kind: "normal"; windowId: number };
    }
  | { kind: "windowRemoved"; windowId: number }
  | { kind: "alarm"; name: string };

export function createEmptyRuntimeSession(input: {
  browserSessionId: BrowserSessionId;
}): RuntimeSession;

export function parseRuntimeSession(
  value: unknown,
  fallbackBrowserSessionId: BrowserSessionId
): RuntimeSession;

export function transferReplacedTab(
  session: RuntimeSession,
  removedTabId: number,
  addedTabId: number
): RuntimeSession;

export function purgeClosedTab(
  session: RuntimeSession,
  tabId: number
): RuntimeSession;

export function scrubRuntimeState(
  session: RuntimeSession,
  inventory: ChromeInventory
): RuntimeSession;
```

`SessionRepository` must expose `loadSession(): Promise<RuntimeSession>` and `saveSession(session: RuntimeSession): Promise<void>`. Keep `loadAssociations` / `saveAssociations` as wrappers that read/write `session.associations` without dropping other fields. `createMemorySessionRepository` and `createChromeSessionRepository` generate `browserSessionId` only when the stored record is absent.

- [ ] **Step 1: Write failing runtime-session tests**

Create `tests/unit/runtime-session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createEmptyRuntimeSession,
  parseRuntimeSession,
  purgeClosedTab,
  scrubRuntimeState,
  transferReplacedTab
} from "../../src/state/runtimeSession";
import type {
  BrowserSessionId,
  OperationGuard,
  RuntimeSession
} from "../../src/domain/types";

const sessionId = "session-a" as BrowserSessionId;

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    ...createEmptyRuntimeSession({ browserSessionId: sessionId }),
    ...overrides
  };
}

describe("runtime session identity", () => {
  it("reuses an existing browserSessionId and does not mint a new one from empty objects", () => {
    const parsed = parseRuntimeSession(
      { schemaVersion: 1, browserSessionId: sessionId, associations: [] },
      "other" as BrowserSessionId
    );
    expect(parsed.browserSessionId).toBe(sessionId);
  });
});

describe("tabs.onReplaced transfer", () => {
  it("moves observation, override, guard subjects, and pending member ids before reconciliation", () => {
    const guard: OperationGuard = {
      id: "00000000-0000-4000-8000-000000000010" as RuntimeSession["operationGuards"][number]["id"],
      browserSessionId: sessionId,
      actionId:
        "00000000-0000-4000-8000-000000000011" as OperationGuard["actionId"],
      operation: "assignTabsToManagedGroup",
      phase: "settling",
      tabIds: [7],
      chromeGroupIds: [11],
      expectedEventKinds: ["tabUpdated"],
      seenEventKinds: [],
      startedAt: 1,
      expiresAt: 5001
    };
    const next = transferReplacedTab(
      session({
        tabObservations: [
          {
            tabId: 7,
            firstObservedAt: 1,
            firstObservedOrdinal: 0,
            lastObservedUrl: "https://a.example/"
          }
        ],
        manualOverrides: {
          "7": { tabId: 7, placement: { kind: "ungrouped" }, createdAt: 1 }
        },
        operationGuards: [guard],
        pendingGroupRemovals: [
          {
            managedGroupId:
              "00000000-0000-4000-8000-000000000001" as RuntimeSession["intentionallyClosedGroupIds"][number],
            removedChromeGroupId: 11,
            oldWindowId: 1,
            memberTabIds: [7],
            memberUrls: ["https://a.example/"],
            renderedTitle: "Other",
            startedAt: 1,
            settleAfter: 751
          }
        ]
      }),
      7,
      99
    );
    expect(next.tabObservations[0]?.tabId).toBe(99);
    expect(next.tabObservations[0]?.firstObservedOrdinal).toBe(0);
    expect(next.manualOverrides["99"]?.placement).toEqual({
      kind: "ungrouped"
    });
    expect(next.manualOverrides["7"]).toBeUndefined();
    expect(next.operationGuards[0]?.tabIds).toEqual([99]);
    expect(next.pendingGroupRemovals[0]?.memberTabIds).toEqual([99]);
  });
});

describe("ordinary removal and worker-wake scrub", () => {
  it("purges a closed tab only when no guard or pending removal still references it", () => {
    const guarded = session({
      tabObservations: [
        {
          tabId: 7,
          firstObservedAt: 1,
          firstObservedOrdinal: 0,
          lastObservedUrl: "https://a.example/"
        }
      ],
      operationGuards: [
        {
          id: "00000000-0000-4000-8000-000000000010" as OperationGuard["id"],
          browserSessionId: sessionId,
          actionId:
            "00000000-0000-4000-8000-000000000011" as OperationGuard["actionId"],
          operation: "ungroupTabs",
          phase: "executing",
          tabIds: [7],
          chromeGroupIds: [],
          expectedEventKinds: ["tabUpdated"],
          seenEventKinds: [],
          startedAt: 1,
          expiresAt: 5001
        }
      ]
    });
    expect(purgeClosedTab(guarded, 7).tabObservations).toHaveLength(1);
    expect(
      purgeClosedTab(
        session({
          tabObservations: [
            {
              tabId: 7,
              firstObservedAt: 1,
              firstObservedOrdinal: 0,
              lastObservedUrl: "https://a.example/"
            }
          ],
          manualOverrides: {
            "7": { tabId: 7, placement: { kind: "ungrouped" }, createdAt: 1 }
          }
        }),
        7
      ).tabObservations
    ).toEqual([]);
  });

  it("scrubs stale tab and group runtime ids against fresh inventory", () => {
    const next = scrubRuntimeState(
      session({
        lastFocusedNormalWindowId: 1,
        operationGuards: [
          {
            id: "00000000-0000-4000-8000-000000000010" as OperationGuard["id"],
            browserSessionId: sessionId,
            actionId:
              "00000000-0000-4000-8000-000000000011" as OperationGuard["actionId"],
            operation: "assignTabsToManagedGroup",
            phase: "settling",
            tabIds: [7, 8],
            chromeGroupIds: [11, 12],
            expectedEventKinds: ["tabUpdated"],
            seenEventKinds: [],
            startedAt: 1,
            expiresAt: 5001
          }
        ],
        associations: [
          {
            managedGroupId:
              "00000000-0000-4000-8000-000000000001" as RuntimeSession["intentionallyClosedGroupIds"][number],
            chromeGroupId: 11,
            chromeWindowId: 1,
            observedTitle: "Other",
            observedMemberUrls: [],
            observedAt: 1
          }
        ]
      }),
      {
        windows: [{ id: 2, focused: true, incognito: false, type: "normal" }],
        tabs: [
          {
            id: 8,
            windowId: 2,
            index: 0,
            chromeGroupId: -1,
            url: "https://a.example/",
            title: "A",
            pinned: false,
            active: true,
            incognito: false,
            lastAccessed: 1
          }
        ],
        groups: [],
        capturedAt: 2
      }
    );
    expect(next.lastFocusedNormalWindowId).toBeUndefined();
    expect(next.operationGuards[0]?.tabIds).toEqual([8]);
    expect(next.operationGuards[0]?.chromeGroupIds).toEqual([]);
    expect(next.associations).toEqual([]);
  });
});
```

Also update `tests/unit/association-reconstruction.test.ts` so reconstructed associations include `observedTitle` and `observedMemberUrls`. Shared groups remain ignored.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/unit/runtime-session.test.ts tests/unit/association-reconstruction.test.ts`

Expected: FAIL because `src/state/runtimeSession.ts` does not exist and `ChromeAssociation` lacks the new fields.

- [ ] **Step 3: Implement the typed session helpers**

Add the types to `src/domain/types.ts`. Implement `createEmptyRuntimeSession`, `parseRuntimeSession`, `transferReplacedTab`, `purgeClosedTab`, and `scrubRuntimeState` in `src/state/runtimeSession.ts`.

`parseRuntimeSession` must:

- Reuse `browserSessionId` when the stored record has one.
- Use `fallbackBrowserSessionId` only when the record is absent or unparseable.
- Default missing arrays/objects rather than throwing on a partial worker-wake record.

`purgeClosedTab` must no-op when any `operationGuards[].tabIds` or `pendingGroupRemovals[].memberTabIds` still contains the id.

`scrubRuntimeState` must drop `lastFocusedNormalWindowId` when that window is absent from inventory, filter guard subjects and associations to IDs still present, and leave `browserSessionId` unchanged.

Update `reconstructAssociations` to set `observedTitle: match.title` and `observedMemberUrls` from inventory tabs whose `chromeGroupId === match.id`. Continue skipping `group.shared`.

Update `sessionRepository.ts` so `loadSession` / `saveSession` persist the whole record at `runtime:v1`. Association helpers must round-trip the rest of the session.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/unit/runtime-session.test.ts tests/unit/association-reconstruction.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/domain/types.ts src/state/runtimeSession.ts src/state/sessionRepository.ts src/chrome/reconstructAssociations.ts tests/unit/runtime-session.test.ts tests/unit/association-reconstruction.test.ts
git commit -m "feat: persist typed session lifecycle state"
```

---

### Task 2: Classify and settle operation guards

**Files:**

- Create: `src/actions/operationGuards.ts`
- Create: `tests/unit/operation-guards.test.ts`

**Interfaces:**

```ts
export const GUARD_QUIET_MS = 750;
export const GUARD_HARD_MS = 5000;

export function buildExpectedFootprint(
  plan: ActionPlan
): Pick<
  OperationGuard,
  | "operation"
  | "expectedEventKinds"
  | "postcondition"
  | "tabIds"
  | "chromeGroupIds"
>;

export type GuardEventDecision =
  | { kind: "unmatched"; session: RuntimeSession }
  | { kind: "defer"; guard: OperationGuard; session: RuntimeSession }
  | { kind: "echo"; guard: OperationGuard; session: RuntimeSession }
  | { kind: "manual"; retiredGuard: OperationGuard; session: RuntimeSession };

export function classifyGuardedEvent(
  event: ChromeEventHint,
  inventory: ChromeInventory,
  session: RuntimeSession,
  now: number
): GuardEventDecision;

export function settleOperationGuards(
  inventory: ChromeInventory,
  session: RuntimeSession,
  now: number
): RuntimeSession;

export function postconditionHolds(
  postcondition: GuardPostcondition,
  inventory: ChromeInventory
): boolean;
```

- [ ] **Step 1: Write failing guard tests**

Create `tests/unit/operation-guards.test.ts` covering:

1. `routeToGroup` / `routeToFallback` footprint: `operation: "assignTabsToManagedGroup"`, `tabIds: [plan.tab.id]`, `expectedEventKinds` including `tabUpdated`, `groupCreated` or `groupUpdated`, and `tabMoved`/`tabAttached` as needed, postcondition `{ kind: "tabPlacement", tabIds, windowId, chromeGroupId }` when routing to an existing group, or tabPlacement without a chromeGroupId when creating.
2. `ungroup` footprint: `operation: "ungroupTabs"`, postcondition `{ kind: "tabPlacement", tabIds, windowId, ungrouped: true }`.
3. First matching event during `executing` returns `defer`, records `seenEventKinds`, and does not remove the guard.
4. Matching event during `settling` returns `echo` only while fresh inventory still satisfies the postcondition, and moves `settleAfter` to `now + 750` bounded by `expiresAt`.
5. Fresh inventory that contradicts the postcondition returns `manual` and removes the guard.
6. An expired guard is settled from fresh inventory before classification: still-satisfied → echo/retire; contradiction → manual. Elapsed time alone does not delete it.
7. Unmatched events and guards whose `browserSessionId` differs from the current session cannot suppress manual classification.
8. `settleOperationGuards` retires a settling guard only after quiet (`now >= settleAfter`) or hard deadline (`now >= expiresAt`) **and** a fresh postcondition check. A still-busy executing guard is left in place.

Include this exact case:

```ts
it("does not consume a guard on the first matching event", () => {
  const decision = classifyGuardedEvent(
    {
      kind: "tabUpdated",
      tabId: 7,
      urlChanged: false,
      groupChanged: true,
      pinnedChanged: false
    },
    inventoryWithTabInTarget,
    sessionWithExecutingGuard,
    100
  );
  expect(decision.kind).toBe("defer");
  expect(
    decision.kind === "defer" && decision.session.operationGuards
  ).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/unit/operation-guards.test.ts`

Expected: FAIL because `src/actions/operationGuards.ts` does not exist.

- [ ] **Step 3: Implement classification and settlement**

Implement the module. A guard matches an event when:

- `event.kind` is in `expectedEventKinds`, and
- the event's tab/group id intersects `tabIds` / `chromeGroupIds` (for `tabReplaced`, either `addedTabId` or `removedTabId`).

`expiresAt` is `startedAt + GUARD_HARD_MS`. Quiet extension may not move `settleAfter` past `expiresAt`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/unit/operation-guards.test.ts tests/unit/runtime-session.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/actions/operationGuards.ts tests/unit/operation-guards.test.ts
git commit -m "feat: classify operation-guard echoes without consuming the first event"
```

---

### Task 3: Write guards from the Action Engine and retry transient drags

**Files:**

- Create: `src/actions/retryPolicy.ts`
- Modify: `src/actions/executeActionPlan.ts`
- Modify: `src/actions/types.ts` if `ActionEngineDeps` is introduced
- Modify: `src/controller/controller.ts` only as needed to pass session into `executeActionPlan`
- Create: `tests/unit/retry-policy.test.ts`
- Create: `tests/component/action-recovery.test.ts`
- Modify existing component tests that call `executeActionPlan` / the controller so they still compile

**Interfaces:**

```ts
export type MutationErrorClass =
  "transient-drag" | "gone" | "permission" | "invalid" | "unknown";
export function classifyMutationError(error: unknown): MutationErrorClass;
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  refresh: () => Promise<ChromeInventory>,
  delay: (ms: number) => Promise<void>
): Promise<T>;

export interface ActionEngineDeps {
  chrome: ChromeMutationPort;
  session: SessionRepository;
  now?: () => number;
  createId?: () => UUID;
  delay?: (ms: number) => Promise<void>;
}

export async function executeActionPlan(
  plan: ActionPlan,
  deps: ActionEngineDeps
): Promise<ActionResult>;
```

Retry policy: on `"Tabs cannot be edited right now"` (string match, case-insensitive substring), class is `transient-drag`. Delays are 50 ms then 150 ms. Fresh inventory before each retry. Stop after three failures. `gone` is satisfied only when a later task's postcondition check would pass; for this task, a vanished tab after `refresh` returns without throwing if the planned postcondition already holds, otherwise it is `gone` and does not retry. `permission` / `invalid` never retry.

- [ ] **Step 1: Write failing retry and recovery tests**

`tests/unit/retry-policy.test.ts`: script the drag error twice, succeed on the third attempt, assert delays `[50, 150]` and a refresh before each retry. After three failures, stop. Permission errors never retry.

`tests/component/action-recovery.test.ts`:

1. Successful `routeToGroup` writes an `executing` guard before `groupTabs`, then a `settling` guard after verification with `verifiedAt`, `settleAfter = now + 750`, `expiresAt = startedAt + 5000`.
2. The guard is still present after the executor returns; the executor does not delete it.
3. If `groupTabs` throws, the executing guard is removed.
4. A second executor/controller constructed over the same memory session, while a settling guard exists, reads inventory and calls `settleOperationGuards`; it does not replay the old plan's remaining mutations.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/unit/retry-policy.test.ts tests/component/action-recovery.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement retry + guard writes**

Change `executeActionPlan(plan, chrome)` to `executeActionPlan(plan, deps)`. Update `controller.ts` and existing tests (`tests/component/route-first-tab.test.ts`, `tests/component/rule-controller.test.ts`) to the new signature. Do not add new routing behavior in those tests.

Before every mutation, `saveSession` with the new executing guard. After verified postcondition, move that guard to `settling`. Use `executeWithRetry` around `groupTabs`, `updateGroup`, and `ungroupTabs`.

- [ ] **Step 4: Run focused tests plus existing routing tests**

Run: `npx vitest run tests/unit/retry-policy.test.ts tests/component/action-recovery.test.ts tests/component/route-first-tab.test.ts tests/component/rule-controller.test.ts tests/unit/operation-guards.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/actions/retryPolicy.ts src/actions/executeActionPlan.ts src/actions/types.ts src/controller/controller.ts tests/unit/retry-policy.test.ts tests/component/action-recovery.test.ts tests/component/route-first-tab.test.ts tests/component/rule-controller.test.ts
git commit -m "feat: recover action execution behind session operation guards"
```

---

### Task 4: Classify Chrome events for loading, replacement, shared groups, and focus

**Files:**

- Create: `src/controller/eventClassifier.ts`
- Create: `tests/unit/event-classifier.test.ts`

This task is pure classification plus session observation updates. It must not call `ChromeMutationPort`. Group-removal settlement stays in Task 6; this task only forwards `groupRemoved` as a request to settle later.

**Interfaces:**

```ts
export interface EventClassification {
  guarded: boolean;
  deferred: boolean;
  manualOverride?: ManualOverride;
  requests: ReconciliationRequest[];
  session: RuntimeSession;
}

export type ReconciliationRequest =
  | { scope: { kind: "tab"; tabId: number }; reason: string }
  | { scope: { kind: "group"; chromeGroupId: number }; reason: string }
  | { scope: { kind: "all" }; reason: string };

export function classifyChromeEvent(
  event: ChromeEventHint,
  inventory: ChromeInventory,
  session: RuntimeSession,
  now: number
): EventClassification;
```

Classification order:

1. Ignore events whose subject tab/group/window is incognito or missing from a non-normal window. `windowFocusChanged` with `{ kind: "none" }` returns no requests and does not change `lastFocusedNormalWindowId`. `{ kind: "normal", windowId }` may set it only when that window exists in inventory as `type: "normal"`.
2. `tabReplaced`: `transferReplacedTab` first, then request reconciliation of `addedTabId`.
3. `classifyGuardedEvent`. `defer` → `{ guarded: true, deferred: true, requests: [] }`. `echo` → `{ guarded: true, deferred: false, requests: [] }` (no manual override). `manual` continues to unguarded classification with the retired session.
4. `tabCreated` / `tabUpdated` with no committed `http:`/`https:` URL: record observation if needed, request nothing that would route, reason `"not-routable"`.
5. `tabUpdated` with `urlChanged` / `groupChanged` / `pinnedChanged` all false: refresh observation URL/title only; do not classify placement.
6. `tabActivated`: bump observation recency (`lastObservedUrl` stays, `firstObservedOrdinal` stays). Never write a placement override.
7. `tabRemoved`: `purgeClosedTab` when no guard/pending record needs the id.
8. Shared-group members (`inventory.groups` entry with `shared: true` containing the tab): no mutation request; do not write a managed-group override.

- [ ] **Step 1: Write failing classifier tests**

Cover the eight bullets above plus: `onCreated` empty URL then `onUpdated` committed URL produces a route request only on the second event.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/unit/event-classifier.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `classifyChromeEvent`**

Keep it a pure function of `(event, inventory, session, now)`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/unit/event-classifier.test.ts tests/unit/operation-guards.test.ts tests/unit/runtime-session.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/controller/eventClassifier.ts tests/unit/event-classifier.test.ts src/domain/types.ts
git commit -m "feat: classify Chrome lifecycle events before reconciliation"
```

---

### Task 5: Hold manual placement, including unmanaged leaveWherePlaced

**Files:**

- Modify: `src/controller/eventClassifier.ts`
- Modify: `src/controller/controller.ts`
- Modify: `src/actions/planActions.ts` and/or `src/controller/controller.ts` so `reconcileTab` respects overrides
- Create: `tests/component/session-overrides.test.ts`

**Behavior:**

- A contradictory `manual` guard decision, or an unguarded user placement change (`tabMoved` / `tabAttached` / `tabUpdated` with `groupChanged` into a different group or ungrouped), writes `ManualOverride`:
  - managed group whose title matches a non-shared association → `{ kind: "managedGroup", managedGroupId }`
  - `chromeGroupId < 0` → `{ kind: "ungrouped" }`
  - unmanaged native group (`chromeGroupId >= 0`, no managed association, `shared: false`) → `{ kind: "leaveWherePlaced" }` without storing that native `groupId`
  - shared group → `{ kind: "leaveWherePlaced" }` and no automatic mutation
- `reconcileTab` returns `{ kind: "held", reason: "unmanaged-placement" }` for `leaveWherePlaced` and `{ kind: "held", reason: "manual-override" }` (add this reason to `ActionResult` if missing) for managed/ungrouped overrides, and plans no Chrome mutation.
- A later manual move into a representable managed group or ungrouped state replaces the override.
- Browser restart is a new empty `RuntimeSession`; overrides do not survive that. Worker recreation over the same session storage must keep them.

- [ ] **Step 1: Write failing override tests**

```ts
it("keeps a manual destination through rule changes until restart", async () => {
  await controller.handleChromeEvent({
    kind: "tabMoved",
    tabId: tab.id,
    windowId: 7,
    fromIndex: 1,
    toIndex: 2
  });
  await controller.replaceConfiguration(editedRules);
  expect(chrome.mutationsFor(tab.id)).toEqual([]);
});

it("leaves a tab in an unmanaged native group until restart", async () => {
  // move into chrome group 99 with shared:false and no managed association
  // then change rules and fire tabUpdated urlChanged
  // expect zero groupTabs/ungroupTabs/updateGroup calls
});
```

Also: shared-group member produces zero mutation calls; `tabActivated` after a manual move does not clear the override.

If `handleChromeEvent` does not exist yet, add the smallest controller method that classifies, saves session, and skips routing when held. Full queue coalescing can wait for Task 7, but these tests must pass through the public controller API.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/component/session-overrides.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement override writes and reconcile holds**

Add `manual-override` to held reasons in `src/actions/types.ts`. `planRuleRoute` / controller must check session overrides before planning. Do not persist unmanaged `groupId`.

- [ ] **Step 4: Run override plus existing routing tests**

Run: `npx vitest run tests/component/session-overrides.test.ts tests/component/route-first-tab.test.ts tests/component/rule-controller.test.ts tests/unit/event-classifier.test.ts`

Expected: PASS. Existing routing tests still route when no override exists.

- [ ] **Step 5: Commit**

```powershell
git add src/controller src/actions/types.ts src/actions/planActions.ts tests/component/session-overrides.test.ts
git commit -m "feat: preserve manual tab placement until Chrome restart"
```

---

### Task 6: Settle group removal without guessing a UUID

**Files:**

- Create: `src/groups/groupLifecycle.ts`
- Modify: `src/controller/eventClassifier.ts` to start pending removal and call settlement
- Create: `tests/unit/group-lifecycle.test.ts`

**Interfaces:**

```ts
export const GROUP_SETTLEMENT_ALARM = "tabroute:group-settlement";

export function startPendingGroupRemoval(input: {
  session: RuntimeSession;
  inventoryBeforeRemoval: ChromeInventory;
  removed: ChromeGroupSnapshot;
  now: number;
}): RuntimeSession;

export function settlePendingGroupRemovals(input: {
  session: RuntimeSession;
  inventory: ChromeInventory;
  configuration: Configuration;
  now: number;
}): RuntimeSession;
```

Rules:

- `groupRemoved` alone stores `PendingGroupRemoval` from the removed association's `managedGroupId`, rendered title, last observed member URLs/IDs, `settleAfter = now + 750`. It does **not** write `intentionallyClosedGroupIds`.
- After quiet or on later group/tab/window events, `settlePendingGroupRemovals` looks at current inventory:
  - Unique match: same rendered title **and** overlapping member URLs or transferred member tab IDs, in a different normal window, `shared: false` → update that association's `chromeGroupId`/`chromeWindowId`, clear the pending record. Do not duplicate the managed UUID onto a second group.
  - Two or more candidate groups → leave pending, attach nothing.
  - No candidate after `now >= settleAfter` → if the managed group `isPersistent`, append its UUID to `intentionallyClosedGroupIds`; always clear the pending record. Non-persistent groups just clear pending without a close marker.
- Shared groups are never a reconstruction candidate.
- An extension move whose settling guard still spans the removed/created group IDs is an echo (Task 2); settlement must not write a manual override or a second association for that UUID.

- [ ] **Step 1: Write failing group-lifecycle tests**

Cover: removal-only does not close; unique cross-window reconstruct; two same-title groups remain unattached; shared group is ignored; persistent settled absence writes the intentional-close marker; non-persistent settled absence does not.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/unit/group-lifecycle.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement settlement**

Keep this module free of Chrome mutation calls.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/unit/group-lifecycle.test.ts tests/unit/event-classifier.test.ts tests/unit/association-reconstruction.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/groups/groupLifecycle.ts src/controller/eventClassifier.ts tests/unit/group-lifecycle.test.ts
git commit -m "feat: settle group removal before attaching or closing a UUID"
```

---

### Task 7: Controller event intake, coalescing queue, and worker wake

**Files:**

- Modify: `src/controller/controller.ts`
- Create: `tests/component/controller-lifecycle.test.ts`

**Public controller API:**

```ts
handleChromeEvent(event: ChromeEventHint): Promise<EventClassification>;
handleTabUpdated(tab: ChromeTabSnapshot): Promise<ActionResult | EventClassification>;
onWorkerWake(): Promise<void>;
replaceConfiguration(next: Configuration): Promise<void>;
getConfiguration(): Configuration;
```

`handleTabUpdated` must keep existing routing tests green: treat it as `tabUpdated` with `urlChanged` inferred from a committed URL, then reconcile that tab unless classification deferred/held.

Queue rules:

- Coalesce repeated tab events for the same `tabId` into one reconciliation.
- Serialize overlapping group/tab work (no concurrent `executeActionPlan` for overlapping subjects).
- After an executing-guard `defer`, enqueue those subjects once the executor moves the guard to `settling` or removes it.
- `onWorkerWake`: `loadSession`, `readInventory`, `scrubRuntimeState`, `settleOperationGuards`, `settlePendingGroupRemovals`, `saveSession`. Never resume a stored action plan. Then reconcile tabs that still have deferred/pending work or are otherwise eligible.

- [ ] **Step 1: Write failing controller-lifecycle tests**

1. Coalesce two `tabUpdated` events for tab 42 into one `executeActionPlan`.
2. Extension `routeToGroup` multi-event sequence (`groupCreated` + `tabUpdated`) writes no `manualOverrides`.
3. During settling, a contradictory inventory (user dragged the tab to another group) writes a manual override and performs no compensating mutation.
4. Construct a second controller over the same memory session with an executing guard and a deferred tab; `onWorkerWake` settles from inventory and does not duplicate `groupTabs`.
5. Loading tab then committed URL still routes at most once (existing route-first-tab behavior preserved).

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/component/controller-lifecycle.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement controller wiring**

`handleChromeEvent` reads fresh inventory, classifies, saves session, then enqueues. It never calls `ChromeMutationPort` except through `executeActionPlan`.

- [ ] **Step 4: Run controller and prior lifecycle tests**

Run: `npx vitest run tests/component/controller-lifecycle.test.ts tests/component/session-overrides.test.ts tests/component/action-recovery.test.ts tests/component/route-first-tab.test.ts tests/component/rule-controller.test.ts tests/unit/operation-guards.test.ts tests/unit/group-lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/controller/controller.ts tests/component/controller-lifecycle.test.ts
git commit -m "feat: reconcile Chrome events through guards and a coalesced queue"
```

---

### Task 8: Background event wiring and isolated Chromium proof

**Files:**

- Modify: `entrypoints/background.ts`
- Create: `tests/unit/background-events.test.ts` (source assertions)
- Create: `tests/e2e/lifecycle.spec.ts`
- Modify: `tests/unit/architecture.test.ts` if new files need the mutation-boundary assertion

**Background wiring:**

Register listeners only after `ready`. Every Chrome event maps to `controller.handleChromeEvent`. On worker start, after controller construction, call `controller.onWorkerWake()`.

Required listeners:

- `chrome.tabs.onCreated`, `onUpdated`, `onActivated`, `onMoved`, `onAttached`, `onDetached`, `onRemoved`, `onReplaced`
- `chrome.tabGroups.onCreated`, `onUpdated`, `onMoved`, `onRemoved`
- `chrome.windows.onFocusChanged`, `onRemoved`
- `chrome.alarms.onAlarm` for `tabroute:group-settlement` (create the named alarm when a pending removal is stored; Task 6 constant)

Map `windowId === chrome.windows.WINDOW_ID_NONE` to `{ kind: "windowFocusChanged", focus: { kind: "none" } }`. Do not store that value. Filter window types to normal when the API accepts `windowTypes: ["normal"]`. Ignore incognito in `toSnapshot` as today. Do not add `runtime.onSuspend`.

`onUpdated` must pass `urlChanged` / `groupChanged` / `pinnedChanged` from `changeInfo`, not only `changeInfo.url || status === "complete"`.

- [ ] **Step 1: Write failing source and e2e tests**

`tests/unit/background-events.test.ts` reads `entrypoints/background.ts` as text and asserts it contains `tabs.onReplaced`, `tabs.onActivated`, `tabGroups.onRemoved`, `windows.onFocusChanged`, `WINDOW_ID_NONE`, `onWorkerWake`, and does not contain `onSuspend`.

`tests/e2e/lifecycle.spec.ts` uses the same isolated production-session helper pattern as `tests/e2e/extension.spec.ts` (`launchExtensionSession`, never the user profile):

1. Open a tab with a delayed committed URL (extension page or `https://example.com`); assert the worker does not throw and manager query still succeeds after navigation.
2. Restart the worker via `session.restartWorker()` while the extension is loaded; manager query succeeds afterward (extends the existing worker-restart proof with a routed tab still present).
3. Create a native group from the test page by grouping two http(s) tabs; rename it away from the fallback title through Chrome; assert TabRoute does not recreate a second fallback group in that window (query inventory through the live port is not available from Playwright — instead, assert via manager query that group count in configuration is unchanged and no crash occurs). Prefer evaluating `chrome.tabGroups.query` from an extension page if the session exposes the extension origin.

Do not require a live Chrome 137 shared-group in bundled Chromium. Shared-group byte-for-byte hold remains covered by unit/component tests with `shared: true`.

- [ ] **Step 2: Run the tests and confirm the source assertion fails**

Run: `npx vitest run tests/unit/background-events.test.ts`

Expected: FAIL on missing listeners.

- [ ] **Step 3: Wire background events**

Keep mutations inside the live adapter + Action Engine. `tabGroups.onUpdated` presentation sync must skip `group.shared` (already skipped when `group.shared` is truthy) and must not run when a settling/executing guard covers that group.

- [ ] **Step 4: Run unit, component, typecheck, and isolated e2e**

Run:

```powershell
npx vitest run tests/unit/background-events.test.ts tests/unit/operation-guards.test.ts tests/unit/runtime-session.test.ts tests/unit/event-classifier.test.ts tests/unit/group-lifecycle.test.ts tests/component/controller-lifecycle.test.ts tests/component/session-overrides.test.ts tests/component/action-recovery.test.ts
npm run typecheck
npm run test:extension
```

If `lifecycle.spec.ts` is not picked up by `test:extension`, add it to that Playwright project or run `npx playwright test tests/e2e/lifecycle.spec.ts` with the same `TABROUTE_PRODUCTION_BUILD_PATH` contract documented in `docs/agent-development-workbench.md`. Prefer extending the existing `test:extension` project so the production gate stays one command.

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add entrypoints/background.ts tests/unit/background-events.test.ts tests/e2e/lifecycle.spec.ts tests/unit/architecture.test.ts
git commit -m "feat: wire Chrome lifecycle events through isolated worker recovery"
```

---

## Spec coverage

| FDM-593 acceptance criterion                                                                       | Task       |
| -------------------------------------------------------------------------------------------------- | ---------- |
| Extension multi-event sequences do not create manual overrides                                     | 2, 3, 7    |
| User drag during/after a guard survives until restart                                              | 2, 5, 7    |
| Cross-window managed-group movement updates ownership without duplicating or intentionally closing | 6, 7       |
| Ambiguous group recreation remains unattached                                                      | 6          |
| Replaced tab inherits observation, override, guards, pending evidence                              | 1, 4       |
| Loading tabs move at most once after a committed URL                                               | 4, 7       |
| Shared groups and members remain untouched by automatic behavior                                   | 4, 5, 6    |
| Worker-recreation recovers deferred events and settlement state                                    | 1, 3, 7, 8 |
| 750 ms quiet / 5 s hard deadline; elapsed time never proves success                                | 2, 3       |
| `WINDOW_ID_NONE` and non-normal windows excluded                                                   | 4, 8       |

## Out of scope (do not implement here)

Persistent-tab repair, window-close shutdown markers beyond group-removal settlement, Sync transport, snapshots, Activity/Undo, UI polish, `moveManagedGroup` as an Action Engine plan, duplicate closure.
