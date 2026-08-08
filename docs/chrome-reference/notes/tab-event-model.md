# Tab event model

Chrome event payloads are triggers, not the final truth. Read fresh tab/group/window state before deciding or mutating.

- Coalesce repeated events by affected tab/group and serialize actions that touch the same resource.
- Tag extension operations in session state. Resulting Chrome events must not become user manual overrides.
- A user drag is authoritative. Do not mutate while Chrome reports tabs cannot be edited; retry the idempotent operation with a finite backoff.
- Treat removed IDs as normal races. Verify before closing, moving, grouping, or focusing.
- Only record a manual override after determining that the move was not an extension operation. Overrides last until Chrome restart.
- A manual move into an unmanaged native group creates a session-only `leaveWherePlaced` override. Suppress placement and duplicate closure for that tab until restart, except for persistent-tab repair; do not persist the unmanaged Chrome group ID as identity.
- Relevant tab/group/window events re-arm the one-shot `shutdown-latest` checkpoint alarm. Periodic and debounce scheduling use `chrome.alarms`, not JavaScript timers.
- All automatic mutations travel through the Tab Action Engine; UI and rule code only request plans.
