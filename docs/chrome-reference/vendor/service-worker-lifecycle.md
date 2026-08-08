# Manifest V3 service-worker lifecycle — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
Source title: The extension service worker lifecycle
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

Manifest V3 uses an event-driven extension service worker rather than a persistent background page. The worker can terminate after inactivity and starts again to handle later extension events. Its globals are not durable state.

Initialize event listeners at top level, reload state on wake, and make every reconciliation recoverable from Chrome inventory plus storage. A worker restart must never resume a raw stale mutation; it recomputes the desired action from current tabs/groups/windows. Service workers have no DOM, so a feature that truly needs a DOM must use an explicitly justified extension/offscreen context rather than assume a background page.
