# Persistence invariants

- `ManagedGroup.id` is an extension-owned UUID and is the only durable group identity.
- `chrome.tabGroups.TabGroup.id`, `tabs.Tab.id`, and `windows.Window.id` are runtime associations only. They are never persisted as durable identity.
- Service-worker globals are caches, not state. Sync configuration, local snapshots/history, and session intent survive the appropriate lifecycle; globals need not survive any worker sleep.
- `storage.sync` contains compact configuration only. Snapshots, activity, Undo, and window ownership are local; manual overrides and intentional-close markers are session-only.
- A persistent tab is identified by its extension UUID, group UUID, canonical restore URL, and accepted patterns, never by a Chrome tab ID.
- Live-tab age is extension-owned, session-only observation state keyed by the current session's tab ID. It may survive service-worker recreation through `storage.session`, but it is rebuilt deterministically after a full browser restart and is never durable tab identity.
- Before a destructive operation, take the required automatic local checkpoint. Create a bounded typed Undo record whose browser-session token prevents stale runtime hints from being reused after restart.
- Maintain the reserved `shutdown-latest` checkpoint from normal tab/group/window events. Never depend on `runtime.onSuspend` or another final shutdown callback.
