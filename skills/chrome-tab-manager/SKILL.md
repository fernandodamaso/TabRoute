---
name: chrome-tab-manager
description: Required operating guide for changes to the TabRoute extension.
---

# TabRoute operating guide

## When this skill applies

Read this entire file before changing any Chrome extension code, tab/group behavior, persistence, startup restoration, rules, duplicate handling, snapshots, context menus, shortcuts, permissions, or related tests.

This project is Chrome-only and Manifest V3 in v1. Do not add incognito behavior, notifications, a side panel, a command palette, memory/tab-discard features, browser portability, or feature code not authorized by the approved design.

## Required reading

Always read:

1. `docs/superpowers/specs/2026-08-08-chrome-tab-manager-design.md`
2. `docs/chrome-reference/notes/persistence-invariants.md`
3. `docs/chrome-reference/notes/tab-event-model.md`

Then read the relevant note and its official local snapshot in `docs/chrome-reference/vendor/`. If the snapshot is stale or missing, refresh the allowlisted source pack before relying on an API detail. Do not use non-official documentation as the authority for Chrome API semantics.

## Non-negotiable implementation rules

- Never persist a Chrome `tabId`, `groupId`, or `windowId` as identity. Use extension UUIDs and rebuild runtime associations.
- Treat MV3 service-worker globals as caches only. Durable state belongs in the designated storage area.
- Store portable configuration as one checksummed Sync generation split across items smaller than Chrome's 8,192-byte per-item limit. Write every shard before the head pointer, reject incomplete/mixed generations, and keep the Local last-valid shadow as the recovery point.
- All automated Chrome tab/group mutations go through the Tab Action Engine. UI adapters, context menus, shortcuts, the rule engine, duplicate resolver, and snapshot service must request actions rather than mutate Chrome directly.
- Read fresh Chrome state before mutation and verify the intended postcondition afterward. Chrome event payloads are not complete state.
- Give every extension-triggered mutation a session guard with an expected event footprint and postcondition. Keep the guard through all correlated tab/group events; an event is an echo only while fresh state still satisfies that postcondition. A contradictory user drag retires the guard and remains manual intent.
- Never classify `tabGroups.onRemoved` alone as an intentional close. A cross-window group drag appears as removal plus creation, so settle and correlate fresh membership before closing a managed-group lifecycle.
- Defer routing while a new tab has no committed URL. Transfer observation, override, and guard state across `tabs.onReplaced`.
- Treat Chrome shared groups as unmanaged and never automatically mutate their presentation or member tabs. A missing persistent definition gets a separate managed canonical copy; do not adopt or move the shared tab.
- Preserve a user manual placement until Chrome restarts. Persistent-tab repair is the only exception: a persistent tab moved out of its assigned group returns immediately, except that shared-group members remain untouched and receive a separate managed canonical copy.
- Respect intentional persistent-group closure for the rest of the session. Route matching tabs to `Other`; do not recreate the group early.
- Keep persistent tabs first in their group and preserve their manual order.
- Never mutate incognito tabs or windows.
- Never send a desktop notification. Record automatic results/errors locally and expose them through the popup/settings activity view.

## Change workflow

1. State the affected invariant and event path in the change description.
2. Add or update pure logic tests first for every rule, duplicate, or ordering change.
3. Add component tests using a fake Chrome port for queue, retry, guard, and storage behavior.
4. Add a real-Chrome integration test when changing Chrome lifecycle, grouping, window, startup, context-menu, command, or service-worker behavior.
5. Exercise the restart scenario for any persistence or startup change: pre-existing matching tab, missing persistent tab, intentionally closed group, and fallback window.
6. Verify no new direct Chrome mutation call exists outside the Tab Action Engine.
7. Update the relevant concise note and source manifest/snapshot metadata if a Chrome API fact changed.

## Phase 0 gate

Before feature implementation, complete `docs/chrome-reference/vendor/` using only the URLs in `docs/chrome-reference/sources.json`. Every snapshot needs source attribution, retrieval time, source license notice, and SHA-256. The future updater must be atomic: a failed required fetch leaves the current local set untouched.

Run `npm run docs:chrome:validate` for the offline gate. Use `npm run docs:chrome:update` only when deliberately refreshing the allowlisted sources.

## Review checklist

- Does the change leave every normal tab in its deterministic rule target or `Other`, unless a session override applies?
- Does the change preserve the duplicate survivor order: correct effective placement, then most recently active, then oldest?
- Does it reuse existing acceptable tabs before creating a restore duplicate?
- Does a drag collision retry safely rather than fight the user?
- Does it avoid sync storage for logs, snapshots, Undo, and runtime associations?
- Does every Sync item fit the per-item quota, and can an incomplete remote generation fall back to the Local shadow without applying partial configuration?
- Does every operation guard survive its complete multi-event footprint while allowing a contradictory user drag to win?
- Are Undo and activity records bounded, local, and non-notifying?
- Are permission and host-access implications documented and tested?
