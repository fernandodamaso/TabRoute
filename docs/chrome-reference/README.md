# Chrome extension reference pack

This is the required local reference for the Unified Chrome Tab Manager. Read the project-specific notes first; use the official source snapshots to verify API details that affect a change.

## Layout

- `sources.json` is the canonical, allowlisted source manifest.
- `vendor/` contains one attributed official-source reference extract per manifest item.
- `notes/` contains concise project rules derived from those sources. It is not a replacement for checking an API's current behavior.

## Phase 0 gate

Before feature code is added, refresh each `vendor/*.md` file from its corresponding source, including the URL, title, UTC retrieval time, source license notice, and required API facts. The intended updater is `npm run docs:chrome:update`, as specified in the design. It may fetch only the URLs in `sources.json`, must record the source-content SHA-256 fingerprint in the source manifest, and must preserve existing extracts if a required fetch or validation fails.

Chrome documentation normally uses CC BY 4.0, while code samples use Apache 2.0. Keep source attribution and license notices in every snapshot. Do not copy documentation from other sites into `vendor/`.

## Reading order

1. `notes/persistence-invariants.md`
2. `notes/tab-event-model.md`
3. The note relevant to the change.
4. The matching official-source snapshot in `vendor/`.

See [skills/chrome-tab-manager/SKILL.md](../../skills/chrome-tab-manager/SKILL.md) for the operational rules that make this required.
