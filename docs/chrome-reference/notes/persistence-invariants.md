# Persistence invariants

- `ManagedGroup.id` is an extension-owned UUID and is the only durable group identity.
- `chrome.tabGroups.TabGroup.id`, `tabs.Tab.id`, and `windows.Window.id` are runtime associations only. They are never persisted as durable identity.
- Service-worker globals are caches, not state. Sync configuration, local snapshots/history, and session intent survive the appropriate lifecycle; globals need not survive any worker sleep.
- `storage.sync` contains portable configuration only, committed as a checksummed generation: write bounded revision shards first and the head pointer last. Every item, including its key, must stay below 8,192 bytes; the whole area stays below 102,400 bytes and 512 items. Never assemble a configuration from mixed or incomplete generations. The Local last-valid shadow is the recovery point until a complete remote generation validates.
- A completed remote Sync head is applied through `storage.onChanged`; update the Local shadow, menus, snapshot alarms, and all-tab reconciliation exactly once. A locally written revision already matching the Local shadow is an echo, not a new change.
- Snapshots, activity, Undo, and window ownership are local; manual overrides and intentional-close markers are session-only.
- A persistent tab is identified by its extension UUID, group UUID, canonical restore URL, and accepted patterns, never by a Chrome tab ID.
- Live-tab age is extension-owned, session-only observation state keyed by the current session's tab ID. It may survive service-worker recreation through `storage.session`, but it is rebuilt deterministically after a full browser restart and is never durable tab identity.
- Before a destructive operation, take the required automatic local checkpoint. Create a bounded typed Undo record whose browser-session token prevents stale runtime hints from being reused after restart.
- Maintain the reserved `shutdown-latest` checkpoint from normal tab/group/window events. Never depend on `runtime.onSuspend` or another final shutdown callback.
- Without `unlimitedStorage`, Local and Session each have a 10,485,760-byte quota. Enforce a 9,437,184-byte Local soft budget by pruning expired Undo, stale suggestions, oldest automatic snapshots, and oldest activity in that order; never auto-delete named snapshots or configuration. If one current-browser checkpoint cannot fit after eligible pruning, fail it with an explicit capacity error and block the destructive action.
- Ordinary tab removal purges Session observation/override state after active guards and replacement transfer no longer need it. `tabs.onReplaced` transfers that state to the replacement ID; every worker wake scrubs stale tab/group guard subjects against fresh inventory.
