# Startup restoration

- Let Chrome's own restored session settle before extension repair. v1 uses two quiet inventory scans two seconds apart, with a fifteen-second normal-path cap. Persist the startup coordinator in `storage.session`; short in-worker delays provide the two-second cadence, while a named one-shot `chrome.alarms` recovery wake-up and every relevant Chrome event resume an interrupted coordinator from stored timestamps. The alarm is a recovery backstop because Chrome may delay alarms to its minimum cadence; correctness does not depend on the delay timer surviving worker termination.
- Reuse existing acceptable tabs before creating canonical persistent tabs. Do not rebuild the session blindly.
- Restore in the background and do not focus a tab/window as part of normal repair.
- A prior Chrome `windowId` cannot identify a restarted window. Use exactly one plausible restored-group member as the ownership signal; otherwise choose the most recently focused normal window.
- Restore collapsed state and user-established group order after membership is correct.
- Do not create, inspect, or repair incognito groups/tabs.
- Recreate required interval/startup/checkpoint alarms on every worker wake when absent. Do not use `runtime.onSuspend` or ordinary timers as lifecycle guarantees.
