# chrome.sessions — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/reference/api/sessions
Source title: chrome.sessions API
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

`chrome.sessions` queries and restores recently closed tabs and windows. It requires the `sessions` permission. Recently closed results are finite (the documented maximum is 25) and provide session IDs that are not durable managed-group identities.

Use this API only for bounded Undo/recovery where a suitable recently closed tab/window is still available. Snapshot restoration remains application-owned local data and must reuse currently open acceptable tabs first. If a session restore is unavailable, use the recorded canonical URL and the specified fallback group/window behavior.
