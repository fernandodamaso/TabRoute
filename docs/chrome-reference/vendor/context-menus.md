# chrome.contextMenus — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/reference/api/contextMenus
Source title: chrome.contextMenus API
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

`chrome.contextMenus` creates extension menu items for contexts including tabs and the extension action. It requires the `contextMenus` permission. Items need stable IDs because the event-driven worker can be recreated; registration must be idempotent.

The context-menu adapter must send explicit user-intent commands to the controller. It does not mutate groups/tabs directly. The v1 menu covers rule creation from the tab, persistence, duplicate exclusion, movement, pause, Pin Group, collapse/expand, and snapshots; the rule-creation action opens a prefilled editor and does not auto-save a rule.
