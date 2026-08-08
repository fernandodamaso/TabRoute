# Managed group lifecycle

- The group UUID maps to one live Chrome group association at a time.
- The rendered title is optional emoji plus configured name. User name/color changes update configuration without changing the UUID.
- Create a group only when a matching, restore, or explicit user action has at least one member tab. Native Chrome groups cannot exist empty; create one through `tabs.group()` using the member tab(s), then apply presentation and order.
- `Other` is a configured managed group with a permanent fallback role even if its display name changes.
- If a managed persistent group is intentionally closed, record that session marker and send matching tabs to `Other` until restart.
- Moving a group to another normal window establishes the new home. A group does not replicate to every window.
- Store manual group order and persistent-tab order, then restore them after the required tabs exist.
