# Startup restoration

- Let Chrome's own restored session settle before extension repair. v1 uses two quiet inventory scans two seconds apart, with a fifteen-second cap.
- Reuse existing acceptable tabs before creating canonical persistent tabs. Do not rebuild the session blindly.
- Restore in the background and do not focus a tab/window as part of normal repair.
- A prior Chrome `windowId` cannot identify a restarted window. Use exactly one plausible restored-group member as the ownership signal; otherwise choose the most recently focused normal window.
- Restore collapsed state and user-established group order after membership is correct.
- Do not create, inspect, or repair incognito groups/tabs.
