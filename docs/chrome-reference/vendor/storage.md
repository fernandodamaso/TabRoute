# chrome.storage — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/reference/api/storage
Source title: chrome.storage API
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

`storage.local` is machine-local and has a 10 MB quota by default. `storage.session` is in-memory, survives service-worker restarts during the browser session, and has a 10 MB quota. `storage.sync` synchronizes through Chrome Sync and is limited to 102,400 bytes total, 8,192 bytes per item, 512 items, 120 writes per minute, and 1,800 writes per hour.

Use sync only for compact configuration. Use local for snapshots, activity, and Undo. Use session for manual overrides, intentional-close markers, pause-until-restart state, and extension-operation guards. Treat quota failures as normal errors: preserve existing data, log the failure, and debounce/retry eligible writes rather than deleting user state.
