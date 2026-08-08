# TabRoute — v1 Design Specification

**Status:** Approved design; implementation is deliberately out of scope for this change.

**Product goal:** TabRoute is a Chrome-only Manifest V3 extension that turns automatic grouping, duplicate handling, persistent group tabs, and snapshots into one predictable tab-management system.

## 1. Scope and product principles

The product is a new extension, not a fork or merger of existing extensions. It will selectively study or adapt independently licensed, well-scoped OSS techniques, while keeping one coherent domain model and one automation pipeline.

The extension manages normal Chrome windows only. It quietly organizes tabs, preserves deliberate user actions for the rest of the current Chrome session, and makes all automatic changes inspectable and reversible without interrupting browsing.

The non-negotiable principles are:

- **One source of truth for decisions.** UI and event handlers request actions; they do not directly call Chrome tab/group mutation APIs.
- **User intent wins within a session.** A manual placement is an override until the next Chrome restart.
- **Chrome runtime IDs are ephemeral.** Our IDs are persistent UUIDs; Chrome tab, group, and window IDs are associations that must be reconstructed.
- **Safe automation.** Operations are idempotent, serialized per tab/group, logged locally, and offer short-lived Undo where the browser can still restore the prior state.
- **No silent scope creep.** v1 is organization and persistence; Chrome Memory Saver remains responsible for inactive-tab memory management.

## 2. User-visible behavior

### 2.1 Managed groups

A managed group has a persistent UUID, editable name, Chrome-supported color, optional emoji, rules, duplicate defaults, persistent tabs, portable default order/collapse presentation, and last known local window ownership/order/collapse state. The local observed state wins when restoring on that device; portable defaults apply when no local observation exists. Its rendered Chrome group title is `emoji + space + name` when an emoji is configured, otherwise just `name`.

If a user renames a managed group in Chrome, v1 preserves the configured emoji and updates the configured name from the remainder of the title. If the displayed title no longer begins with the configured emoji, the whole entered title becomes the name and the configured emoji remains prepended on the next managed render. A user recolor updates the managed group's color.

Groups are created only when needed. A matching tab can recreate an absent managed group unless that group was intentionally closed during the current Chrome session. Empty groups are not kept visible solely because they are configured.

Dragging an entire managed group to a normal Chrome window makes that destination its new home. The extension records the group order the user establishes in each home window and restores it when possible. A group is never duplicated into every Chrome window.

### 2.2 The fallback group

`Other` is a special managed group selected by the `fallbackGroupId` setting. It has the same editable name, color, and optional emoji as other groups, but it retains its fallback role even if renamed. It is created only when an unmatched or explicitly redirected tab needs it, and is allowed to disappear when empty.

If no eligible rule matches a normal tab, the extension moves it to `Other`. A rule targeting an intentionally closed group also routes the matching tab to `Other` for the rest of the session. Manually moving a tab out of `Other` is a session override; the popup may offer rule creation, but declining keeps the manual placement until Chrome restarts.

### 2.3 Rule engine

Each rule targets one managed group and has:

- a positive expression tree that must evaluate to true;
- zero or more negative expression trees, none of which may evaluate to true;
- an explicit integer `priority` where the higher number wins;
- an enabled/paused state and an optional timed pause;
- optional per-rule duplicate-policy override; and
- actions from the bounded v1 set: group, ungroup, make persistent in the target group, choose duplicate behavior, and collapse or expand the target group.

The visual editor supports arbitrarily nested `AND` and `OR` expression groups. Leaves support URL, host/domain, path, title, pinned state, opener URL/domain, current group, and regular expression matching. URL and pattern values are validated before saving; invalid regular expressions are rejected and do not replace the last valid rule.

Negative matching means: remove the candidate from the rule's target and continue evaluating all remaining eligible rules. It never means “leave the tab stuck in the old group.” If no rule remains eligible, the tab goes to `Other`, subject to a current session manual override.

The selected target is deterministic:

1. Exclude paused rules and rules whose positive/negative expressions do not match.
2. Select the highest `priority`.
3. If tied, select the greatest calculated specificity: exact URL > exact host > host suffix/wildcard > exact path segment > title/pinned/current-group/opener predicate > regular expression. More matching leaves break ties before fewer; longer literal URL/host/path values break an equal class tie.
4. If still tied, select the rule with the lexicographically smallest UUID. This is stable across devices and does not depend on creation order.

Rule additions, edits, pauses, and deletion re-evaluate all currently open, non-incognito tabs immediately. Tabs with a manual session override retain that placement until Chrome restarts; every other affected tab is routed under the new result, including `Other` where nothing matches.

Automation may be paused globally, per group, or per rule. A pause can end after a duration or at Chrome restart. While a pause applies, it blocks automatic placement and duplicate closure for that scope; it does not block an explicit user command or persistent-tab repair.

### 2.4 Duplicate policy

Duplicate handling is global across normal Chrome windows. Policy resolution is: per-rule override, then target-group override, then global default. A policy can be one of:

- `allow` (no duplicate action);
- exact normalized URL;
- normalized URL without fragment;
- domain only (ignore path);
- URL plus page title;
- URL pattern; or
- an exclusion matching a global URL pattern.

Normalization removes the URL fragment and configured tracking-query parameters before comparison. A policy may explicitly compare the original full URL when that distinction is needed. Global exclusions always result in `allow` and take precedence over all policies.

On a duplicate, choose the survivor in this order: a tab already in the correct managed group, then the most recently active tab, then the oldest tab observed by TabRoute in the current browser session. Chrome does not expose a general creation timestamp for an ordinary live tab, so TabRoute assigns a session-only first-observed ordinal. It survives service-worker recreation through `storage.session`; after a full browser restart, the initial inventory receives deterministic ordinals by normal-window ID, tab index, then tab ID. The final tab-ID comparison is session-local only and is never durable identity. When the existing survivor is in the wrong group, move that survivor to the rule's target group and focus it; close the newly opened duplicate. In every other closure case, focus the survivor and close the new duplicate. Duplicate closures have a short-lived Undo that restores the exact recently closed session entry when Chrome exposes an unambiguous `sessionId`, otherwise recreates the recorded URL through the normal Action Engine and records a degraded result.

### 2.5 Persistent tabs and pinned groups

“Persistent” is an extension concept, distinct from Chrome's native pinned-tab strip. A persistent-tab definition contains one canonical restore URL and one or more acceptable patterns that mean the required tab is already present. The definition belongs to one managed group.

- Closing a persistent tab reopens its canonical URL in the background in the group's current home window and group.
- Dragging a persistent tab outside its group returns it immediately to that group.
- If a persistent tab navigates away from its accepted patterns, the navigated tab is reclassified by the normal rules and a background canonical tab is recreated in the persistent group.
- Persistent tabs occupy the beginning of the group. Their order is the last manual order the user set; temporary tabs follow them.
- **Make persistent in this group** is available from the popup, settings, and tab context menu.
- **Pin Group** makes the group persistent and makes every tab currently in it persistent. Tabs added later remain temporary until explicitly made persistent.

Closing or ungrouping a persistent managed group is an intentional close marker for the current Chrome session. Do not recreate it until the next Chrome restart; route matching tabs to `Other` in the meantime. This marker is runtime-only and cannot sync to another device.

### 2.6 Snapshots, templates, and startup

Users can save named full-browser snapshots and named individual-group snapshots. A snapshot records managed-group UUIDs and presentation, tab URLs and duplicate keys, persistent membership/order, collapsed state, group order, and the local window-ownership descriptor. It excludes incognito tabs and does not treat Chrome runtime IDs as durable identity.

Automatic local snapshots run on a configurable interval and immediately before an extension operation that closes one or more tabs or removes/ungroups a managed group. A reserved `shutdown-latest` checkpoint is maintained continuously from ordinary tab/group/window events through a debounced one-shot `chrome.alarms` wake-up; correctness never depends on a final shutdown callback. Restoring a snapshot reuses matching existing tabs before creating missing ones and follows duplicate policy rather than opening avoidable copies.

At `runtime.onStartup`, the controller first allows Chrome session restoration to settle: it waits for two consecutive normal-window inventory scans two seconds apart with no intervening tab-created or URL-updated event, capped at fifteen seconds. It then restores persistent groups in the background, reuses acceptable existing tabs, and creates only missing canonical tabs. It restores each group's prior collapsed/expanded state and remembered ordering.

Window ownership is local-only. During a live session, the group maps to the Chrome window that currently contains it. At startup the extension identifies a prior home window only when exactly one restored normal window contains an acceptable tab or group member recorded for that managed group; otherwise it uses Chrome's most recently focused normal window. It never relies on a persisted `windowId` to identify a new browser-session window.

Templates are reusable group blueprints containing presentation, persistent tabs, attached rule definitions, and duplicate settings. Creating a template instance produces fresh UUIDs for the managed group and cloned rules; it does not create a link that changes existing instances. v1 does not import settings from the user's existing extensions.

### 2.7 UI, commands, and suggestions

The extension has a small action popup and a full settings page.

- **Popup:** automation status, current tab/group actions, quick move, make/remove persistent, Pin Group, save snapshot, Undo, recent activity, and a quiet Suggestions section.
- **Settings:** visual nested rule editor, groups, colors/emojis, persistent tabs, duplicate defaults/exclusions, pause controls, snapshots, templates, activity-log view, and sync/local data diagnostics.
- **Context menus:** add rule from this tab, make/remove persistent, exclude from duplicates, move to a managed group, move to `Other`, pause automation for this tab's scope, Pin Group, collapse/expand, and save snapshot. “Create rule from this tab” opens a prefilled visual rule editor; it never silently creates a rule.
- **Shortcuts:** declare all major actions as extension commands so users can bind them in `chrome://extensions/shortcuts`. At most four receive suggested defaults because Chrome limits suggested keys; remaining commands are intentionally unbound by default.

The extension never sends desktop notifications in v1. Every automatic result, failure, retry, and Undo is recorded in the local activity log; the popup is the only place suggestions surface. A suggestion is created after five manual moves of the same normalized domain into the same managed group within a rolling 14-day local window. It proposes a rule but never creates one automatically.

## 3. Architecture

```text
Chrome APIs and UI commands
          |
          v
Event Intake + Reconciliation Queue
          |
          v
Tab State Controller ----> Runtime State (storage.session)
          |                         |
          |                         v
          |                  Intent/closed-group/undo guards
          v
Rule Engine ------> Duplicate Resolver ------> Persistent-tab Reconciler
          \                 |                         /
           \                v                        /
            -----> Tab Action Engine <---------------
                         |
                         v
                chrome.tabs / chrome.tabGroups / windows
                         |
                         v
     Configuration (storage.sync) + Local state (storage.local)
```

### 3.1 Component responsibilities

| Component | Responsibility | May call Chrome mutation APIs? |
|---|---|---:|
| Event Intake | Converts Chrome events into deduplicated reconciliation requests. | No |
| Tab State Controller | Loads durable state, owns the queue, resolves runtime associations, applies session overrides. | No |
| Rule Engine | Pure evaluation of a tab snapshot against rules and target selection. | No |
| Duplicate Resolver | Pure candidate/key calculation and survivor selection. | No |
| Persistent-tab Reconciler | Detects missing/moved/navigated persistent definitions and requests repairs. | No |
| Tab Action Engine | Plans, executes, verifies, compensates, and records group/tab mutations. | Yes, exclusively |
| Snapshot Service | Captures/restores local snapshots and templates through the controller. | Requests only |
| UI adapters | Render state and issue explicit user commands. | No |
| Activity/Undo Service | Persists bounded action records and inverse operations. | No |

The background service worker is event-driven and can stop at any time. In-memory maps are caches only. On every wake, the controller reloads durable configuration and session state, reconciles current Chrome inventory, then processes pending work. No UI code may call `chrome.tabs.group`, `chrome.tabs.move`, `chrome.tabs.ungroup`, `chrome.tabs.remove`, or `chrome.tabGroups.update` directly.

### 3.2 Event and data flow

For `tabs.onCreated`, `tabs.onUpdated`, `tabs.onMoved`, `tabs.onAttached`, `tabs.onDetached`, `tabs.onRemoved`, `tabGroups` lifecycle events, window-focus changes, and explicit commands:

1. Ignore incognito and extension-internal action echoes identified by an operation guard.
2. Read a fresh tab/group/window snapshot; event payloads are hints, not authoritative state.
3. Register manual movement/rename/color changes as appropriate, including a session override for a user-initiated tab placement.
4. Queue the smallest affected reconciliation unit, coalescing repeated events for the same tab/group.
5. Evaluate pause/override/intentional-close constraints, rules, duplicate policy, and persistent obligations.
6. Build one action plan. Mutations run in dependency order: create or restore missing tabs, move them to the target window, create a missing native group from at least one actual member (or attach members to the verified existing group), update group presentation/collapse state, restore tab/group ordering, focus the survivor, then close a duplicate only after the survivor is freshly verified.
7. Verify the postcondition from Chrome state, add a bounded Undo record if applicable, write an activity entry, and schedule a retry only for transient failures.

Rule and settings changes begin at step 4 with all current normal tabs as the reconciliation set. Snapshot restoration enters at step 5 after reuse matching tabs are identified. User commands pass an explicit `source: user` intent and are not overridden by a pause.

## 4. Data model and storage boundaries

All versioned records include `schemaVersion`, `id` where applicable, `createdAt`, and `updatedAt`. A startup validator rejects malformed records, retains the last valid configuration, and logs the actionable error locally.

| Record | Essential fields | Storage |
|---|---|---|
| `ManagedGroup` | UUID, name, emoji, color, fallback flag, persistent flag, duplicate override, default order/collapse | Sync for portable configuration; actual home/order/collapse observations are Local |
| `Rule` | UUID, target group UUID, priority, positive/negative ASTs, action set, duplicate override, pause state | Sync |
| `PersistentTab` | UUID, group UUID, canonical URL, accepted patterns, manual persistent-order key | Sync |
| `DuplicateSettings` | global default, global exclusions, normalization options | Sync |
| `Template` | UUID, group blueprint, cloned rule/persistent-tab definitions | Sync |
| `Snapshot` | UUID, name, scope, captured groups/tabs/ownership descriptors | Local only |
| `ActivityEntry` | action, result, affected IDs/URLs, timestamp, error code when any | Local only, automatically trimmed |
| `UndoRecord` | typed inverse payload, browser-session token, expiry, pre-action ephemeral association hints | Local only, automatically expires |
| `SuggestionState` | rolling manual-move observations and dismissals keyed by normalized domain + managed-group UUID | Local only, automatically trimmed |
| `RuntimeSession` | browser-session token, manual overrides, intentional closed-group UUIDs, pause-until-restart flags, action guards, live associations, tab observations, startup coordination, prefilled rule-draft records | `storage.session` |
| `ChromeAssociation` | managed group UUID to current tabGroup ID/window ID, observed Chrome group metadata | `storage.session`; rebuilt every browser session |

`chrome.storage.sync` stores only compact configuration and never snapshots, activity logs, undo records, raw tab inventories, or session IDs. Its roughly 100 KB total and 8 KB-per-item limits require normalized records, separate keys by entity, debounced writes, and an explicit preflight size check. `chrome.storage.local` holds snapshots/history and uses bounded retention; it must surface a local log error if a quota write fails. `chrome.storage.session` holds restart-scoped intent because service-worker globals do not survive worker suspension.

No Chrome `tabId`, `groupId`, or `windowId` is persisted as identity. In particular, `chrome.tabGroups.TabGroup.id` is unique only during a browser session. Chrome values are associations, not domain keys.

## 5. Failure handling and recovery

| Condition | v1 behavior |
|---|---|
| Tab/group disappears between read and action | Re-read inventory; if absent, treat action as satisfied or discard it without error notification. |
| User drags while a mutation is attempted | Do not fight the drag. Retry the idempotent action with bounded exponential backoff; after three failures, log it and await a later event or user command. |
| Service worker restarts mid-operation | Recover state from storage, verify Chrome inventory, and recompute rather than resuming a stale raw action. |
| Sync quota or network failure | Keep last confirmed local configuration, log failure, retry debounced sync writes, and never discard configuration/snapshots to make space automatically. |
| Invalid rule/pattern or incompatible action | Reject before persistence, preserve prior valid state, display the field error in settings, and write an activity error. |
| Closed persistent group during session | Preserve the intentional-close marker; do not repair it before Chrome restart. |
| Duplicate closure fails | Keep both tabs, log the failure, and never close a survivor as compensation. |
| Undo expiry or unavailable original window/group | Reopen/move into the current applicable group or `Other`; log the degraded Undo result. |
| No eligible normal window on restore | Defer restoration until one appears; never create an incognito or popup-window group. |

Automatic actions are not retried indefinitely. Errors are visible in local activity and settings, never via notifications. Every mutation has an operation guard so Chrome's resulting events are reconciled rather than misclassified as a manual override.

## 6. Permissions, platform, and privacy

v1 targets Google Chrome 121+ and Manifest V3; Chrome 121 is the minimum because deterministic duplicate ordering uses `tabs.Tab.lastAccessed`. It excludes incognito windows at intake and does not request incognito behavior. Required permissions will be derived and minimized during implementation, expected to include `tabs`, `tabGroups`, `storage`, `contextMenus`, `sessions`, and `alarms`; shortcuts are declared under the top-level `commands` manifest key, which is not a permission. Host access must be limited to the URL-reading capability required by approved rule types and explained in the install copy.

All configuration syncing uses Chrome Sync. Snapshots, activity, Undo, window ownership, and session intent remain local. v1 has no remote service, telemetry, analytics, account, collaboration, or notification channel.

## 7. Phase 0 — Chrome documentation knowledge pack

No feature implementation may begin until this pack exists, is current, and the project skill has been read. The checked-in structure is:

```text
docs/chrome-reference/
  README.md
  sources.json
  vendor/
    README.md
    tabs.md
    tab-groups.md
    windows.md
    storage.md
    alarms.md
    service-worker-lifecycle.md
    service-worker-migration.md
    runtime.md
    sessions.md
    commands.md
    context-menus.md
    match-patterns.md
    testing.md
  notes/
    tab-event-model.md
    group-lifecycle.md
    startup-restoration.md
    persistence-invariants.md
    chrome-api-gotchas.md
skills/chrome-tab-manager/SKILL.md
```

The official pages listed in `sources.json` are captured as local, attributed reference extracts in `vendor/` before application code is written and refreshed deliberately before an API-dependent change. Each extract includes its URL, retrieval timestamp, document title, license notice, and the API facts on which this project relies. The future updater additionally records a SHA-256 source-content fingerprint in `sources.json` for every refreshed extract. Chrome developer documentation is generally CC BY 4.0, with code samples under Apache 2.0; preserve both attribution and the original license notices. `vendor/` is source material, while `notes/` is the concise, project-owned interpretation agents must follow.

The Phase 0 update command is specified as `npm run docs:chrome:update`. Its future implementation must download only `sources.json` entries, preserve attribution/header metadata, convert or retain readable local content, atomically replace a successful snapshot set, update hashes/timestamps, and fail without modifying the old set if any required page fails validation. It must not fetch or execute remote code.

The project skill is a mandatory operating guide: it requires the relevant notes before a behavioral change, forbids using Chrome runtime group IDs as persistent identity, keeps mutations behind the Action Engine, and requires event-loop and restart tests for lifecycle changes.

## 8. Testing and acceptance strategy

Testing is layered so pure logic does not depend on Chrome and browser behavior is proven in a real extension host.

| Layer | Focus | Required v1 cases |
|---|---|---|
| Unit | AST evaluation, priority/specificity, duplicate keys/survivor, persistent requirements, storage validation | nested AND/OR; positives/negatives; tie-breaks; all duplicate policies; manual override; invalid regex; persistent navigation |
| Component | controller/action plans using a fake Chrome port | event coalescing; action guards; retry; group recreation; intentional close; Undo; quota errors |
| Browser integration | unpacked MV3 extension in Chrome test profile | actual group create/move/collapse, cross-window duplicate focus/closure, context menus, commands, worker wake/restart |
| End-to-end | clean profile and restored profile | startup settle/reuse/missing restore, window-home resolution/fallback, snapshot/template restore, no incognito mutation |
| Manual release checks | Chrome UI behavior and permissions | popup/settings accessibility, emoji titles, user drag wins until restart, no notifications, log visibility |

The acceptance matrix must demonstrate these invariants before v1 is considered complete:

- A matching tab obeys the deterministic rule result or `Other` fallback.
- A manual group placement is never automatically reversed before Chrome restart.
- Persistent repair works in the background without stealing focus and respects an intentional group close.
- A duplicate in another window uses the survivor order, focuses the survivor, and can be undone.
- Restart reuses existing acceptable tabs, restores missing ones, preserves collapsed/order state, and never uses persisted Chrome IDs as identity.
- Every automatic mutation has an activity entry; no desktop notification is emitted.

## 9. OSS reuse strategy

Existing projects are research inputs, not a base codebase. Study Tab Session Manager and GoogleChromeLabs Browser Tab Session Manager for snapshot/storage patterns; Tab Options and Tab Vacuum for focused duplicate normalization/detection; and Tabli for tab/window UI patterns. The prior Tab Groups Extension and Duplicate Tabs Closer inform user behavior only; v1 does not import their settings.

Before copying any code, record the repository URL, immutable commit SHA, files/functions considered, license, attribution requirement, compatibility with the extension's chosen license, and security review in `docs/oss-attribution.md`. Copy only a small, isolated algorithm when its tests can be brought with it or independently reproduced. Do not merge repositories, retain their architecture, or copy their UI wholesale. If license/provenance is unclear, reimplement from the documented behavior instead.

## 10. Explicit v1 non-goals

- Browsers other than Google Chrome.
- Incognito management of any kind.
- Native Chrome pinned-tab management; “persistent” belongs to this extension's managed groups.
- Tab discarding, hibernation, memory/RAM optimization, or replacement for Chrome Memory Saver.
- Side panel, command palette, tab/group search, AI usage badges, accounts, cloud backend, telemetry, or desktop notifications.
- Unlimited history, unlimited Undo, cross-device snapshots, snapshot sync, and settings migration/import from existing extensions.
- Group capacity limits, overflow rules, duplicate groups per window, or named workspaces.
- Raw JSON rule editing or automatic rule creation from observed behavior.
- Plugin architecture or arbitrary user-supplied action code.

## 11. Design self-review

This document was reviewed after drafting for incomplete markers, conflicting persistence behavior, storage misuse, and ambiguous tie-breaking. The implementation-plan audit further corrected four Chrome-specific assumptions: native groups require real member tabs; live-tab age is session-observed because Chrome exposes no general creation time; the last-session checkpoint is maintained by events/alarms rather than a shutdown hook; and `commands` is a manifest key rather than a permission. The review also resolved priority direction and final tie-breaker; manual override precedence during rule changes; the boundary between temporary runtime IDs and durable UUIDs; intentionally closed-group behavior; startup settlement; window fallback; `Other`'s renamed fallback role; suggestion threshold; and the four-suggested-shortcut Chrome limit. There are no deferred product decisions in this v1 specification.
