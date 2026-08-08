# Chrome API gotchas

- In a service worker, Chrome's “current window” can differ from the focused window; use explicit window IDs or `getLastFocused` only when the design calls for it.
- `TabGroup.id` is unique only in a browser session. It cannot be a sync or snapshot key.
- `tabs.Tab.active` says active in its own window, not necessarily the focused window.
- Reading `url`, `pendingUrl`, `title`, or `favIconUrl` requires the proper `tabs` or host permission. Keep permission rationale current.
- `storage.sync` allows 102,400 bytes total, 8,192 bytes per item including its key, and 512 items. Do not write inventories/history/snapshots there, and do not store the complete configuration under one key.
- `storage.local` and `storage.session` each allow 10,485,760 bytes without `unlimitedStorage`; count bounds alone do not prove quota safety.
- Chrome permits only four suggested command keys; users can bind more commands through `chrome://extensions/shortcuts`.
- `commands` is a top-level manifest object, not a permission. Only `contextMenus`, `sessions`, and `alarms` from those background features belong in `permissions`.
- A native group is created by `chrome.tabs.group()` with at least one tab. `chrome.tabGroups` cannot create an empty group independently.
- Service-worker JavaScript timers do not provide durable scheduling. Use `chrome.alarms`, verify required alarms whenever the worker starts, and treat delivery as delayed rather than exact. Chrome may delay an alarm to its minimum cadence, so a two-second startup-settlement loop may use short in-worker delays only as an optimization while persisting enough state for event/alarm recovery.
- `runtime.onSuspend` for background scripts is not supported in extension service workers; never make shutdown correctness depend on it.
- `tabs.Tab.lastAccessed` is available, but ordinary live tabs have no general creation timestamp. TabRoute's oldest-tab tie-break uses restart-scoped observation metadata.
- `tabs.onCreated` may arrive before URL/group membership is populated; `Tab.url` can be empty while `pendingUrl` is available. `tabs.onUpdated` exposes URL, group, and pinned changes, and `tabs.onReplaced` swaps runtime tab IDs during prerender/Instant.
- A group move within one window fires member-tab moves plus a group move; a cross-window group move fires group removal and creation instead. A one-event guard and immediate close classification are both unsafe.
- `windows.onFocusChanged` may emit `WINDOW_ID_NONE`, including transiently before a real Chrome-window focus event on some Linux window managers.
- Chrome 137+ exposes `TabGroup.shared`; v1 treats shared groups as unmanaged.
- Context menus need the `contextMenus` permission and should use stable IDs because the worker may be recreated.
- Pattern matching for extension permissions is not a substitute for the product's richer rule-expression semantics.
