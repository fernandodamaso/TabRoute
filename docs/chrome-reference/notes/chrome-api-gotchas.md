# Chrome API gotchas

- In a service worker, Chrome's “current window” can differ from the focused window; use explicit window IDs or `getLastFocused` only when the design calls for it.
- `TabGroup.id` is unique only in a browser session. It cannot be a sync or snapshot key.
- `tabs.Tab.active` says active in its own window, not necessarily the focused window.
- Reading `url`, `pendingUrl`, `title`, or `favIconUrl` requires the proper `tabs` or host permission. Keep permission rationale current.
- `storage.sync` is quota-limited; do not write inventories/history/snapshots there.
- Chrome permits only four suggested command keys; users can bind more commands through `chrome://extensions/shortcuts`.
- `commands` is a top-level manifest object, not a permission. Only `contextMenus`, `sessions`, and `alarms` from those background features belong in `permissions`.
- A native group is created by `chrome.tabs.group()` with at least one tab. `chrome.tabGroups` cannot create an empty group independently.
- Service-worker JavaScript timers do not provide durable scheduling. Use `chrome.alarms`, verify required alarms whenever the worker starts, and treat delivery as delayed rather than exact. Chrome may delay an alarm to its minimum cadence, so a two-second startup-settlement loop may use short in-worker delays only as an optimization while persisting enough state for event/alarm recovery.
- `runtime.onSuspend` for background scripts is not supported in extension service workers; never make shutdown correctness depend on it.
- `tabs.Tab.lastAccessed` is available, but ordinary live tabs have no general creation timestamp. TabRoute's oldest-tab tie-break uses restart-scoped observation metadata.
- Context menus need the `contextMenus` permission and should use stable IDs because the worker may be recreated.
- Pattern matching for extension permissions is not a substitute for the product's richer rule-expression semantics.
