# Persistence invariants

- `ManagedGroup.id` is an extension-owned UUID and is the only durable group identity.
- `chrome.tabGroups.TabGroup.id`, `tabs.Tab.id`, and `windows.Window.id` are runtime associations only. They are never persisted as durable identity.
- Service-worker globals are caches, not state. Sync configuration, local snapshots/history, and session intent survive the appropriate lifecycle; globals need not survive any worker sleep.
- `storage.sync` contains compact configuration only. Snapshots, activity, Undo, and window ownership are local; manual overrides and intentional-close markers are session-only.
- A persistent tab is identified by its extension UUID, group UUID, canonical restore URL, and accepted patterns, never by a Chrome tab ID.
- Before a destructive operation, take the required automatic local snapshot and create a bounded Undo record.
