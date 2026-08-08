# chrome.tabGroups — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/reference/api/tabGroups
Source title: chrome.tabGroups API
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

`chrome.tabGroups` reads and changes native group presentation and location. Grouping/ungrouping tabs themselves uses `chrome.tabs`; group operations include query, get, update, and move. The API exposes title, color, collapsed state, window ID, and a numeric group ID.

The numeric group ID is unique only within a browser session. Never use it as a managed-group identity in sync, local snapshots, templates, or rules. A group moved within one window raises a group move event; a move between windows is observed as removal from one window and creation in the other, so reconciliation must rebuild the association.

`onCreated`, `onUpdated`, `onMoved`, and `onRemoved` are the required lifecycle triggers. A group can be removed because the user closes it or because its membership becomes empty; use current member state and the session operation guard to tell apart extension work, a normal empty group, and an intentional persistent-group close.
