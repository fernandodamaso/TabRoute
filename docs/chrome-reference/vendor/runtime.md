# chrome.runtime — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/reference/api/runtime
Source title: chrome.runtime API
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

`chrome.runtime` provides extension lifecycle and messaging facilities. The v1 controller uses install/update lifecycle handling for schema validation and `runtime.onStartup` as the beginning of startup reconciliation.

`onStartup` does not mean Chrome has already completed session restoration. Queue startup restoration, wait for the design's bounded quiet-window settlement, inspect live normal-window inventory, reuse acceptable tabs, and create only missing persistent tabs. Runtime events must be registered independently of popup/settings lifetime.
