# chrome.commands — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/reference/api/commands
Source title: chrome.commands API
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

`chrome.commands` declares extension commands in the manifest and dispatches them to the service worker. Command descriptions appear in Chrome's shortcut-management UI.

An extension may declare many commands, but Chrome permits at most four suggested keyboard shortcuts. Declare all approved major actions; give defaults only to the four most useful commands, and leave the remainder unbound so users can configure them in `chrome://extensions/shortcuts`. Chrome and operating-system shortcuts take precedence and invalid suggested keys prevent installation.
