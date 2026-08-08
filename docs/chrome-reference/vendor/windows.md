# chrome.windows — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/reference/api/windows
Source title: chrome.windows API
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

`chrome.windows` enumerates, reads, creates, updates, and closes browser windows. The extension must operate only on `normal` windows in v1.

Chrome's “current window” is the window containing the executing extension context; it is not necessarily the focused/topmost window. In a service worker it can fall back to the last active window. Use explicit `windowId` values for planned actions and use `getLastFocused` only for the specified startup fallback.

Window IDs are runtime values. The controller may keep a live association in `storage.session`, but startup ownership is inferred from restored managed-group members and otherwise falls back to the most recently focused normal window.
