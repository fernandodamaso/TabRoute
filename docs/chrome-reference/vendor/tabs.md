# chrome.tabs — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/reference/api/tabs
Source title: chrome.tabs API
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

`chrome.tabs` creates, queries, updates, moves, groups, ungroups, and removes tabs. It is available to extension service workers and extension pages, not content scripts. Reading sensitive `Tab` properties such as URL, pending URL, title, and favicon requires the `tabs` permission or appropriate host permissions.

For this project, use fresh `tabs.query`/`tabs.get` state before planning a change. `Tab.active` means active in its own window, not necessarily the focused window; `lastFocusedWindow: true` is the preferred query for the user's current normal context. `Tab.groupId` is an association only. Use `tabs.onCreated`, `onUpdated`, `onMoved`, `onAttached`, `onDetached`, `onActivated`, and `onRemoved` as reconciliation triggers, not as complete state.

Moving/grouping can fail while the user is dragging a tab. Retry only an idempotent, freshly verified action with a finite delay; never assume a stale index or tab ID remains valid.
