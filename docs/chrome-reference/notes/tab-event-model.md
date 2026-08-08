# Tab event model

Chrome event payloads are triggers, not the final truth. Read fresh tab/group/window state before deciding or mutating.

- Coalesce repeated events by affected tab/group and serialize actions that touch the same resource.
- Tag extension operations in session state with the affected runtime subjects, expected event kinds, and expected fresh-state postcondition. A group mutation can emit multiple group and member-tab events, so a guard is never consumed by the first match. While execution is unverified, defer matching events; after verification, keep the guard through a short quiet settlement. Classify an event as an echo only while fresh inventory still satisfies the expected postcondition. If fresh state contradicts it, retire the guard and preserve the user's change.
- A user drag is authoritative. Do not mutate while Chrome reports tabs cannot be edited; retry the idempotent operation with a finite backoff.
- Treat removed IDs as normal races. Verify before closing, moving, grouping, or focusing.
- Only record a manual override after determining that the move was not an extension operation. Overrides last until Chrome restart.
- `tabGroups.onRemoved` is ambiguous: a cross-window group move produces removal in the old window and creation in the new one. Persist a pending removal, settle/re-read inventory, and correlate the managed UUID through member evidence before deciding that a persistent group was intentionally closed.
- A manual move into an unmanaged native group creates a session-only `leaveWherePlaced` override. Suppress placement and duplicate closure for that tab until restart, except for persistent-tab repair; do not persist the unmanaged Chrome group ID as identity.
- `tabs.onCreated` can precede its committed URL and group membership. Pending/blank tabs produce a no-mutation hold, not an `Other` move; route after a committed URL arrives. Preserve URL/group/pinned change flags from `tabs.onUpdated`.
- On `tabs.onReplaced`, transfer the removed tab's observation ordinal, manual override, pending lifecycle evidence, and active guard subjects to the added ID before reconciling. On ordinary removal, purge this state once no active lifecycle record needs it.
- Treat `windows.WINDOW_ID_NONE` as absence of focus, never as a home/fallback. Register normal-window filters and tolerate Linux's transient `NONE` before a real focused-window event.
- Relevant tab/group/window events re-arm the one-shot `shutdown-latest` checkpoint alarm. Periodic and debounce scheduling use `chrome.alarms`, not JavaScript timers.
- All automatic mutations travel through the Tab Action Engine; UI and rule code only request plans.
