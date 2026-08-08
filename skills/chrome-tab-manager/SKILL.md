---
name: chrome-tab-manager
description: Required operating guide for changes to the Unified Chrome Tab Manager extension.
---

# Chrome Tab Manager operating guide

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
- All automated Chrome tab/group mutations go through the Tab Action Engine. UI adapters, context menus, shortcuts, the rule engine, duplicate resolver, and snapshot service must request actions rather than mutate Chrome directly.
- Read fresh Chrome state before mutation and verify the intended postcondition afterward. Chrome event payloads are not complete state.
- Tag extension-triggered mutations in session state. Their resulting events must not create manual overrides.
- Preserve a user manual placement until Chrome restarts. Persistent-tab repair is the only exception: a persistent tab moved out of its assigned group returns immediately.
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

## Review checklist

- Does the change leave every normal tab in its deterministic rule target or `Other`, unless a session override applies?
- Does the change preserve the duplicate survivor order: correct group, then most recently active, then oldest?
- Does it reuse existing acceptable tabs before creating a restore duplicate?
- Does a drag collision retry safely rather than fight the user?
- Does it avoid sync storage for logs, snapshots, Undo, and runtime associations?
- Are Undo and activity records bounded, local, and non-notifying?
- Are permission and host-access implications documented and tested?
