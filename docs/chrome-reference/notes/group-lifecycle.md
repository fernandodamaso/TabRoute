# Managed group lifecycle

- The group UUID maps to one live Chrome group association at a time.
- The rendered title is optional emoji plus configured name. User name/color changes update configuration without changing the UUID.
- Create a group only when a matching, restore, or explicit user action needs one. Empty groups may disappear.
- `Other` is a configured managed group with a permanent fallback role even if its display name changes.
- If a managed persistent group is intentionally closed, record that session marker and send matching tabs to `Other` until restart.
- Moving a group to another normal window establishes the new home. A group does not replicate to every window.
- Store manual group order and persistent-tab order, then restore them after the required tabs exist.
