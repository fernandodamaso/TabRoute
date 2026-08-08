# Chrome extension testing — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/how-to/test
Source title: Chrome extension testing guidance
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

Chrome's extension guidance supports isolated tests for logic and browser-level tests for extension behavior. This project requires both: pure engines run without Chrome, while lifecycle, grouping, worker, context-menu, command, and startup behavior runs against an unpacked MV3 extension in a clean Chrome profile.

Tests must not infer behavior from a single event payload. Browser tests prove the state after Chrome events settle, including cross-window grouping, user drag races, service-worker restart, Chrome session restore, and the exclusion of incognito windows.
