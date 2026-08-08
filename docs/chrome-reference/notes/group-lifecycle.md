# Managed group lifecycle

- The group UUID maps to one live Chrome group association at a time.
- The rendered title is optional emoji plus configured name. User name/color changes update configuration without changing the UUID.
- Create a group only when a matching, restore, or explicit user action has at least one member tab. Native Chrome groups cannot exist empty; create one through `tabs.group()` using the member tab(s), then apply presentation and order.
- `Other` is a configured managed group with a permanent fallback role even if its display name changes.
- If a managed persistent group is intentionally closed, record that session marker and send matching tabs to `Other` until restart.
- Moving a group to another normal window establishes the new home. A group does not replicate to every window.
- Chrome reports a cross-window group move as removal plus creation, not `tabGroups.onMoved`. Do not interpret removal alone as intentional closure; settle and reconstruct the association from fresh destination membership first.
- Treat Chrome 137+ shared groups as unmanaged in v1. Do not automatically associate, rename, move, collapse, close, or route member tabs out of them; explicit user movement of an individual tab remains allowed. Shared-group management is a later-version concern.
- While normal windows close, do not recreate each persistent tab. Batch pending window closures until two seconds of window-event quiet. If any normal window remains after the batch, mark the closed windows' persistent groups intentionally closed for the session; if none remains, treat the whole batch as browser shutdown and defer to next startup without close markers or repairs.
- Store manual group order and persistent-tab order, then restore them after the required tabs exist.
