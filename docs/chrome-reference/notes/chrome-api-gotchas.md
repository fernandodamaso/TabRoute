# Chrome API gotchas

- In a service worker, Chrome's “current window” can differ from the focused window; use explicit window IDs or `getLastFocused` only when the design calls for it.
- `TabGroup.id` is unique only in a browser session. It cannot be a sync or snapshot key.
- `tabs.Tab.active` says active in its own window, not necessarily the focused window.
- Reading `url`, `pendingUrl`, `title`, or `favIconUrl` requires the proper `tabs` or host permission. Keep permission rationale current.
- `storage.sync` is quota-limited; do not write inventories/history/snapshots there.
- Chrome permits only four suggested command keys; users can bind more commands through `chrome://extensions/shortcuts`.
- Context menus need the `contextMenus` permission and should use stable IDs because the worker may be recreated.
- Pattern matching for extension permissions is not a substitute for the product's richer rule-expression semantics.
