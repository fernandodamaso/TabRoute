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

A managed group has a persistent UUID, editable name, Chrome-supported color, optional emoji, an `enabled` flag, rules, duplicate defaults, persistent tabs, portable default order/collapse presentation, and last known local window ownership/order/collapse state. The `enabled` flag is portable configuration: a disabled non-fallback group is ineligible for automatic routing and persistent repair, while the fallback group remains enabled so unmatched routing stays defined. The local observed state wins when restoring on that device; portable defaults apply when no local observation exists. Its rendered Chrome group title is `emoji + space + name` when an emoji is configured, otherwise just `name`.

If a user renames a managed group in Chrome, v1 preserves the configured emoji and updates the configured name from the remainder of the title. If the displayed title no longer begins with the configured emoji, the whole entered title becomes the name and the configured emoji remains prepended on the next managed render. A user recolor updates the managed group's color.

Groups are created only when needed. A matching tab can recreate an absent managed group unless that group was intentionally closed during the current Chrome session. Empty groups are not kept visible solely because they are configured.

Chrome 137+ shared tab groups are outside v1 management. TabRoute treats a shared group and its member tabs as an unmanaged, no-automatic-mutation placement: it does not associate, rename, recolor, collapse, move, route, or close tabs in that group automatically. Duplicate resolution excludes them from closure. Persistent restoration does not adopt a shared-group tab as the managed persistent instance; if the definition is otherwise missing, it creates the canonical managed copy and leaves the shared copy untouched. A user may explicitly move an individual tab out through a TabRoute command, after which normal routing applies.

Dragging an entire managed group to a normal Chrome window makes that destination its new home. The extension records the group order the user establishes in each home window and restores it when possible. A group is never duplicated into every Chrome window.

### 2.2 The fallback group

`Other` is a special managed group selected by the `fallbackGroupId` setting. It has the same editable name, color, and optional emoji as other groups, but it retains its fallback role even if renamed. It is created only when an unmatched or explicitly redirected tab needs it, and is allowed to disappear when empty.

If no eligible rule matches a normal tab, the extension moves it to `Other`. A rule targeting an intentionally closed group also routes the matching tab to `Other` for the rest of the session. Manually moving a tab out of `Other` is a session override; the popup may offer rule creation, but declining keeps the manual placement until Chrome restarts.

### 2.3 Rule engine

Each rule is configured with one managed-group UUID (used when its placement action is `group`) and has:

- a positive expression tree that must evaluate to true;
- zero or more negative expression trees, none of which may evaluate to true;
- an explicit integer `priority` where the higher number wins;
- an enabled/paused state and an optional timed pause;
- optional per-rule duplicate-policy override; and
- actions from the bounded v1 set: group, ungroup, make persistent in the target group, choose duplicate behavior, and collapse or expand the target group.

The rule engine supports recursive `ConditionNode` evaluation, including nested `AND` and `OR` trees, so existing stored rules remain compatible. The v1 visual editor is deliberately narrower: it creates one positive leaf or a top-level `all` of positive leaves, plus zero or more negative leaf exceptions. Leaves support URL, host/domain, path, title, pinned state, opener URL/domain, current group, and regular expression matching. URL and pattern values are validated before saving; invalid regular expressions are rejected and do not replace the last valid rule.

Current placement is a three-way value: a specific managed-group UUID, an unmanaged native group, or ungrouped. An unmanaged group never satisfies an `ungrouped` condition. A tab without a committed, supported URL is not yet routable; creation/loading events hold it in place until a committed URL arrives, rather than sending it to `Other` and moving it again.

Rule actions are validated as a set. A rule contains exactly one placement action, `group` or `ungroup`; the editor defaults new rules to `group`. `group` makes the rule's configured managed-group UUID the effective destination. `ungroup` makes the effective destination `ungrouped`; for that rule, the configured group UUID is not used for placement, intentional-close checks, or group-level duplicate defaults. `makePersistent` and `setCollapsed` require `group` and cannot coexist with `ungroup`. At most one duplicate-policy action and at most one collapse/expand action are allowed. `makePersistent` is idempotent: it ensures one definition exists in the target group, using the committed URL with its fragment and configured tracking parameters removed as the canonical URL and the exact canonical URL as the initial accepted pattern; an existing definition accepting that canonical URL is reused.

Negative matching means: disqualify that candidate rule and continue evaluating all remaining eligible rules. It never means “leave the tab stuck in the old group.” If no rule remains eligible, the tab goes to `Other`, subject to a current session manual override.

The selected target is deterministic:

1. Exclude paused rules and rules whose positive/negative expressions do not match.
2. Select the highest `priority`.
3. If tied, select the greatest calculated specificity: exact URL > exact host > host suffix/wildcard > exact path segment > title/pinned/current-group/opener predicate > regular expression. More matching leaves break ties before fewer; longer literal URL/host/path values break an equal class tie.
4. If still tied, select the rule with the lexicographically smallest UUID. This is stable across devices and does not depend on creation order.

Rule additions, edits, pauses, and deletion re-evaluate all currently open, non-incognito tabs immediately. Tabs with a manual session override retain that placement until Chrome restarts; every other affected tab is routed under the new result, including `Other` where nothing matches.

Automation may be paused globally, per group, or per rule. A pause can end after a duration or at Chrome restart. While a pause applies, it blocks automatic placement and duplicate closure for that scope; it does not block an explicit user command or persistent-tab repair.

### 2.4 Duplicate policy

Duplicate handling is global across normal Chrome windows. Policy resolution is: per-rule override, then effective managed-target group override, then global default. An `ungroup` rule has no effective managed target and therefore skips the group override. A policy can be one of:

- `allow` (no duplicate action);
- exact normalized URL;
- normalized URL without fragment;
- domain only (ignore path);
- URL plus page title;
- URL pattern; or
- an exclusion matching a global URL pattern.

Normalization removes the URL fragment and configured tracking-query parameters before comparison. A policy may explicitly compare the original full URL when that distinction is needed. Global exclusions always result in `allow` and take precedence over all policies.

On a duplicate, choose the survivor in this order: a tab already at the effective destination (the correct managed group or ungrouped), then the most recently active tab, then the oldest tab observed by TabRoute in the current browser session. Chrome does not expose a general creation timestamp for an ordinary live tab, so TabRoute assigns a session-only first-observed ordinal. It survives service-worker recreation through `storage.session`; after a full browser restart, the initial inventory receives deterministic ordinals by normal-window ID, tab index, then tab ID. The final tab-ID comparison is session-local only and is never durable identity. When the existing survivor is at the wrong placement, move it to the effective managed group or ungroup it as required, then focus it and close the newly opened duplicate. In every other closure case, focus the survivor and close the new duplicate. Duplicate closures have a short-lived Undo that restores the exact recently closed session entry when Chrome exposes an unambiguous `sessionId`, otherwise recreates the recorded URL through the normal Action Engine and records a degraded result.

### 2.5 Persistent tabs and pinned groups

“Persistent” is an extension concept, distinct from Chrome's native pinned-tab strip. A persistent-tab definition contains one canonical restore URL and one or more acceptable patterns that mean the required tab is already present. The definition belongs to one managed group.

- Closing a persistent tab reopens its canonical URL in the background in the group's current home window and group.
- Dragging a persistent tab outside its group returns it immediately to that group.
- If a persistent tab navigates away from its accepted patterns, the navigated tab is reclassified by the normal rules and a background canonical tab is recreated in the persistent group.
- Persistent tabs occupy the beginning of the group. Their order is the last manual order the user set; temporary tabs follow them.
- **Make persistent in this group** is available from the popup, settings, and tab context menu.
- **Pin Group** makes the group persistent and makes every tab currently in it persistent. Tabs added later remain temporary until explicitly made persistent.

Every quick-action or rule-driven **make persistent** operation is idempotent. It uses the tab's committed URL with fragment and configured tracking parameters removed as the canonical URL, initializes accepted patterns with that exact canonical URL, and reuses an existing target-group definition that already accepts it rather than creating a duplicate definition.

Closing or ungrouping a persistent managed group is an intentional close marker for the current Chrome session. Do not recreate it until the next Chrome restart; route matching tabs to `Other` in the meantime. This marker is runtime-only and cannot sync to another device.

When a normal window is closing, TabRoute never recreates its persistent tabs one by one. It batches window-removal evidence until two seconds of window-event quiet, persisting that settlement across worker recreation. If one or more normal windows remain after the quiet batch, the persistent groups formerly owned by the closed windows are treated as intentionally closed for the session. If none remains, TabRoute treats the whole batch as browser shutdown: it performs no repair and writes no intentional-close markers, leaving the next browser session's startup restore to recover them.

### 2.6 Snapshots and startup

Users can save named full-browser snapshots and named individual-group snapshots. A snapshot records managed-group UUIDs and presentation, tab URLs and duplicate keys, persistent membership/order, collapsed state, group order, and the local window-ownership descriptor. It excludes incognito tabs and does not treat Chrome runtime IDs as durable identity.

Automatic local snapshots run on a configurable interval and immediately before an extension operation that closes one or more tabs or removes/ungroups a managed group. Every snapshot restore is checkpoint-required because it can reorganize many tabs even when it closes none. A reserved `shutdown-latest` checkpoint is maintained continuously from ordinary tab/group/window events through a debounced one-shot `chrome.alarms` wake-up; correctness never depends on a final shutdown callback. Restoring a snapshot reuses matching existing tabs before creating missing ones and follows duplicate policy rather than opening avoidable copies. Snapshot restore is not configuration rollback: if any recorded managed-group UUID no longer exists, preflight rejects the whole restore with `SNAPSHOT_GROUP_MISSING` before mutation and identifies the missing groups; v1 neither silently resurrects nor remaps deleted groups.

At `runtime.onStartup`, the controller first allows Chrome session restoration to settle: it waits for two consecutive normal-window inventory scans two seconds apart with no intervening tab-created or URL-updated event, capped at fifteen seconds. It then restores persistent groups in the background, reuses acceptable existing tabs, and creates only missing canonical tabs. It restores each group's prior collapsed/expanded state and remembered ordering.

Window ownership is local-only. During a live session, the group maps to the Chrome window that currently contains it. At startup the extension identifies a prior home window only when exactly one restored normal window contains an acceptable tab or group member recorded for that managed group; otherwise it uses Chrome's most recently focused normal window. It never relies on a persisted `windowId` to identify a new browser-session window.

### 2.7 UI and commands

The toolbar popup and the options entry point render one shared manager. The manager is a fixed 520 × 600 shell with a 52 px header, a 42 px primary navigation row, and one feature-owned scroll body. The toolbar opens Groups. The options entry point uses the same manager when a full extension page is needed. Primary destinations are Groups, Rules, Activity, and Settings. Persistent tabs stay inside the selected-group inspector; Settings owns only the global persistent-startup switch. Snapshots and Diagnostics are reached from Settings and each has an explicit return path to Settings.

- **Groups:** managed-group navigation, group identity and enablement, routing rules, behavior, and persistent tabs for the selected group.
- **Rules:** overview filters, the flat IF/AND/NOT editor, duplicate/delete actions, and the confirmation overlay.
- **Activity:** local activity history and the only Undo surface.
- **Settings:** global automation/startup controls, data actions, Snapshots navigation, Diagnostics navigation, and local/sync diagnostics.
- **Context menus:** add rule from this tab, make/remove persistent, exclude from duplicates, move to a managed group, move to `Other`, pause automation for this tab's scope, Pin Group, collapse/expand, and save snapshot. “Create rule from this tab” opens a prefilled visual rule editor; it never silently creates a rule.
- **Shortcuts:** declare all major actions as extension commands so users can bind them in `chrome://extensions/shortcuts`. At most four receive suggested defaults because Chrome limits suggested keys; remaining commands are intentionally unbound by default.

The extension never sends desktop notifications in v1. Every automatic result, failure, retry, and Undo is recorded in the local activity log. Activity is the only Undo surface.

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
| Snapshot Service | Captures/restores local snapshots through the controller. | Requests only |
| UI adapters | Render state and issue explicit user commands. | No |
| Activity/Undo Service | Persists bounded action records and inverse operations. | No |

The background service worker is event-driven and can stop at any time. In-memory maps are caches only. On every wake, the controller reloads durable configuration and session state, reconciles current Chrome inventory, then processes pending work. No UI code may call `chrome.tabs.group`, `chrome.tabs.move`, `chrome.tabs.ungroup`, `chrome.tabs.remove`, or `chrome.tabGroups.update` directly.

### 3.2 Event and data flow

For `tabs.onCreated`, `tabs.onUpdated`, `tabs.onActivated`, `tabs.onMoved`, `tabs.onAttached`, `tabs.onDetached`, `tabs.onRemoved`, `tabs.onReplaced`, `tabGroups` lifecycle events, window-focus changes, Sync changes, and explicit commands:

1. Ignore incognito. Correlate possible extension echoes through an operation guard's full expected event footprint and fresh-state postcondition; never consume a guard on its first event.
2. Read a fresh tab/group/window snapshot; event payloads are hints, not authoritative state.
3. If a matching action is still executing, defer classification. After its postcondition verifies, treat correlated events as echoes only while fresh state still matches; a contradictory user drag retires the guard and becomes manual intent. Settle `groupRemoved` before distinguishing a cross-window move from an intentional close.
4. Register manual movement/rename/color changes as appropriate, including a session override for a user-initiated tab placement. Transfer observation, override, lifecycle, and guard state on `tabs.onReplaced`; purge it after an ordinary removal when no active record needs it.
5. Queue the smallest affected reconciliation unit, coalescing repeated events for the same tab/group. A blank/loading tab or a session-protected unmanaged/shared placement produces an explicit no-mutation hold.
6. Evaluate pause/override/intentional-close constraints, rules, duplicate policy, and persistent obligations.
7. Build one action plan. Mutations run in dependency order: create or restore missing tabs, move them to the target window, create a missing native group from at least one actual member (or attach members to the verified existing group), update group presentation/collapse state, restore tab/group ordering, focus the survivor, then close a duplicate only after the survivor is freshly verified.
8. Verify the postcondition from Chrome state, move the guard into a short quiet-settlement phase, add a bounded Undo record if applicable, write an activity entry, and schedule a retry only for transient failures.

Rule and settings changes begin at step 4 with all current normal tabs as the reconciliation set. Snapshot restoration enters at step 5 after reuse matching tabs are identified. User commands pass an explicit `source: user` intent and are not overridden by a pause.

## 4. Data model and storage boundaries

All versioned records include `schemaVersion`, `id` where applicable, `createdAt`, and `updatedAt`. A startup validator rejects malformed records, retains the last valid configuration, and logs the actionable error locally.

| Record | Essential fields | Storage |
|---|---|---|
| `ManagedGroup` | UUID, name, emoji, color, enabled flag, fallback flag, persistent flag, duplicate override, default order/collapse | Sync for portable configuration; actual home/order/collapse observations are Local |
| `Rule` | UUID, target group UUID, priority, positive/negative ASTs, action set, duplicate override, pause state | Sync |
| `PersistentTab` | UUID, group UUID, canonical URL, accepted patterns, manual persistent-order key | Sync |
| `DuplicateSettings` | global default, global exclusions, normalization options | Sync |
| `Template` | UUID, group blueprint, cloned rule/persistent-tab definitions | Sync |
| `Snapshot` | UUID, name, scope, captured groups/tabs/ownership descriptors | Local only |
| `ActivityEntry` | action, result, affected IDs/URLs, timestamp, error code when any | Local only, automatically trimmed |
| `UndoRecord` | typed inverse payload, browser-session token, expiry, pre-action ephemeral association hints | Local only, automatically expires |
| `RuntimeSession` | browser-session token, manual overrides, intentional closed-group UUIDs, pause-until-restart flags, lifecycle action guards, pending group/window closures, pending Sync revision, live associations, tab observations, startup coordination, prefilled rule-draft records | `storage.session` |
| `ChromeAssociation` | managed group UUID to current tabGroup ID/window ID, observed Chrome group metadata | `storage.session`; rebuilt every browser session |

`chrome.storage.sync` stores only portable configuration and never snapshots, activity logs, Undo records, raw tab inventories, or session IDs. It uses immutable, versioned generations rather than one `config:v1` item. Each generation has bounded shard items named `config:v1:revision:<revisionId>:<index>` and one `config:v1:head` record containing the revision ID, ordered shard keys/count, canonical-configuration SHA-256, schema version, and update timestamp. A save serializes and validates the complete configuration, splits it so the measured JSON value plus key is at most 7,600 bytes (safely below Chrome's 8,192-byte per-item maximum), and preflights the final generation plus head against the 102,400-byte total and 512-item limits. When old and new generations fit together, it stages the new one before cleanup. When they do not, it first confirms the old complete revision in `config-shadow:v1`, removes the old Sync shards, and performs a single-generation rollover; during that interval the old head is intentionally invalid and every client remains on its own last-valid shadow. In both modes it writes all new shards, reads and validates them, then publishes the head pointer last. Only after the head validates does it update the Local shadow; obsolete generations are best-effort cleanup. Loading never mixes revision IDs. An absent, incomplete, oversized, checksum-invalid, or schema-invalid head remains unapplied and the last-valid Local shadow continues to serve.

The service worker listens to `storage.onChanged`. Shard-only arrivals do nothing until a head identifies a candidate revision. If the head arrives before all remote shards, TabRoute records that pending revision in Session and retries on later relevant changes or a named alarm; it never partially applies it. Once a complete remote revision validates, TabRoute atomically refreshes the Local shadow, rebuilds dynamic menus, reconciles snapshot alarms, and enqueues all-tab reconciliation. A revision already matching the Local shadow is an own-write/event echo, preventing loops across worker recreation.

`chrome.storage.local` has a 10,485,760-byte hard quota without `unlimitedStorage`; TabRoute does not request that permission. It enforces a 9,437,184-byte soft budget in addition to count limits. Before a checkpoint, eligible pruning removes expired Undo, oldest automatic interval snapshots, then oldest activity; named user snapshots and configuration shadow are never automatically deleted. At the 50-snapshot count limit, a new named snapshot may replace the oldest automatic snapshot but otherwise fails with `SNAPSHOT_LIMIT`; an automatic capture skips and logs when no automatic snapshot is eligible. If the single replacement checkpoint still cannot fit, the write returns `CHECKPOINT_CAPACITY`, and the Action Engine blocks the destructive operation. `chrome.storage.session` also has a 10,485,760-byte limit. Ordinary removal garbage-collects tab observations/overrides after active guards/replacements release them, and every worker wake scrubs stale runtime IDs against fresh inventory.

No Chrome `tabId`, `groupId`, or `windowId` is persisted as identity. In particular, `chrome.tabGroups.TabGroup.id` is unique only during a browser session. Chrome values are associations, not domain keys.

## 5. Failure handling and recovery

| Condition | v1 behavior |
|---|---|
| Tab/group disappears between read and action | Re-read inventory; if absent, treat action as satisfied or discard it without error notification. |
| User drags while a mutation is attempted or settling | Do not fight the drag. A fresh-state contradiction retires the echo guard and preserves the manual result; transient edit collisions retry the idempotent action with bounded exponential backoff, then stop after three failures. |
| Service worker restarts mid-operation | Recover state from storage, verify Chrome inventory, and recompute rather than resuming a stale raw action. |
| Incomplete/invalid remote Sync generation | Do not change active configuration. Keep the last-valid Local shadow, record the pending/error state, and retry only when another relevant Sync change or named recovery alarm arrives. |
| Sync per-item/total/item-count or network failure | Reject before publishing the head, preserve the last-valid Local shadow and the prior Sync generation when space permits, log exact diagnostics, and retry bounded/debounced writes without applying partial data. |
| Local checkpoint capacity | Prune only eligible automatic/history records within the soft budget. If the replacement checkpoint alone cannot fit, return `CHECKPOINT_CAPACITY` and perform no destructive mutation. |
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
| Unit | AST evaluation, priority/specificity, duplicate keys/survivor, persistent requirements, storage validation | recursive engine AND/OR; flat-editor positives/negatives; tie-breaks; all duplicate policies; manual override; invalid regex; persistent navigation |
| Component | controller/action plans using a fake Chrome port | event coalescing; multi-event guards; Sync generation/remote change; routability; replacement transfer/GC; retry; group recreation; intentional close; Undo; byte quota errors |
| Browser integration | unpacked MV3 extension in Chrome test profile | actual group create/move/collapse, manual persistent-group cross-window drag, cross-window duplicate focus/closure, context menus, commands, worker wake/restart |
| End-to-end | clean profile and restored profile | startup settle/reuse/missing restore, `WINDOW_ID_NONE` focus sequence, window-close semantics, deleted-group snapshot rejection, shared-group hold, window-home resolution/fallback, snapshot restore, no incognito mutation |
| Manual release checks | Chrome UI behavior and permissions | shared-manager accessibility, emoji titles, user drag wins until restart, no notifications, log visibility |

The acceptance matrix must demonstrate these invariants before v1 is considered complete:

- A matching tab obeys the deterministic rule result or `Other` fallback.
- A manual group placement is never automatically reversed before Chrome restart.
- Persistent repair works in the background without stealing focus and respects an intentional group close.
- A duplicate in another window uses the survivor order, focuses the survivor, and can be undone.
- Restart reuses existing acceptable tabs, restores missing ones, preserves collapsed/order state, and never uses persisted Chrome IDs as identity.
- Every automatic mutation has an activity entry; no desktop notification is emitted.
- A disabled non-fallback group is not selected for automatic routing or persistent repair, while the enabled fallback remains available.
- A partially arrived Sync generation never replaces the active Local shadow; one complete remote revision applies menus, alarms, and all-tab reconciliation once.
- A multi-event group mutation never becomes a manual override, while a contradictory real user drag during settlement always does.
- A persistent group's cross-window removal/creation sequence changes home rather than becoming an intentional close; a full multi-window browser shutdown creates no close markers.
- A blank/loading tab stays in place until its committed URL produces one routing decision, and replacement preserves its session intent/age.

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
- Quick Actions, rule suggestions, reusable Templates, and a standalone Persistent tabs screen.
- Group capacity limits, overflow rules, duplicate groups per window, or named workspaces.
- Automatic management, association, or restoration of Chrome shared tab groups.
- Raw JSON rule editing or automatic rule creation from observed behavior.
- Plugin architecture or arbitrary user-supplied action code.

## 11. Design self-review

This document was reviewed after drafting for incomplete markers, conflicting persistence behavior, storage misuse, and ambiguous tie-breaking. The implementation-plan audits corrected native-group creation, session-observed tab age, event/alarm checkpoints, command declarations, complete Action/Undo contracts, and then the remaining storage/event-lifecycle risks. The final round added checksummed Sync generations and remote-change application; total/per-item/item-count and Local/Session byte budgets; multi-event operation-guard lifecycles; cross-window group-removal settlement; tab replacement/routability; managed/unmanaged/ungrouped placement distinctions; window-focus/closure semantics; deleted-group snapshot rejection; shared-group safety; checkpoint metadata; and legal rule-action combinations. All identified review findings now have an explicit contract and verification path, with no deferred product decisions in v1.
