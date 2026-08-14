# TabRoute v1 release checklist

Automated gates prove the production package in isolated Chromium. This checklist covers the remaining human-only branded Chrome Stable steps. Do not treat `npm run test:e2e` as the release gate — it mixes fixture workbench specs and skips the production scan. Use the quality matrix in `docs/agent-development-workbench.md` plus `npm run zip` and `npm run verify:zip`.

## Automated evidence (agent / CI)

- [ ] `npm ci`
- [ ] `npm run docs:chrome:validate`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm test -- --run`
- [ ] `npm run test:coverage`
- [ ] `npm run test:workbench`
- [ ] `npm run test:extension`
- [ ] `npm run smoke:popup`
- [ ] `npm run build`
- [ ] `npm run zip`
- [ ] `npm run verify:zip` (scans the zip tree, not only the tmp production build)
- [ ] `tests/e2e/canonical-frames/` contains 10 PNG + 10 JSON files for nodes `39:2`, `42:2`, `42:3`, `42:4`, `42:6`, `42:8`, `214:1303`, `42:11`, `90:312`, `91:348`
- [ ] Structural contract holds: 520×600 viewport, header 52, nav 42, body 506; Settings keeps `aria-current` on Snapshots and Diagnostics
- [ ] Primary nav is exactly Groups, Rules, Activity, Settings; Persistent tabs remain inspector-only; canceled historical surfaces stay absent

## Human-only branded Chrome Stable

Composer never operates the user Chrome profile. A human must complete these on current Chrome Stable with a fresh normal profile.

| Check                                                                                                   | Pass / Fail | Notes |
| ------------------------------------------------------------------------------------------------------- | ----------- | ----- |
| Load unpacked `.output/chrome-mv3` in a fresh normal profile                                            |             |       |
| Toolbar opens the shared 520×600 Groups manager without clipping                                        |             |       |
| `chrome://extensions` permissions match tabs, tabGroups, storage, contextMenus, sessions, alarms        |             |       |
| Top-level commands show nine names with four suggested shortcuts                                        |             |       |
| Shortcut remapping still dispatches the same typed commands                                             |             |       |
| Groups, Rules, Activity, Settings, Snapshots, and Diagnostics destinations are reachable                |             |       |
| Persistent tabs appear only in the Groups inspector; startup switch only in Settings                    |             |       |
| Primary nav stays four destinations; canceled historical surfaces are absent                            |             |       |
| Group edit survives popup close and a full Chrome restart                                               |             |       |
| Rule Save changes routing; Cancel does not; disabled groups are not auto-selected                       |             |       |
| Worker stop/restart from `chrome://extensions` still answers manager queries                            |             |       |
| Native group creation, persistent whole-group two-window drag, and shared-group hold behave as designed |             |       |
| Interval / checkpoint alarms and capacity failure are observable                                        |             |       |
| Exact and degraded Activity Undo work without desktop notifications                                     |             |       |
| Zip install smoke: unpack `.output/tabroute-*-chrome.zip` and load once                                 |             |       |
| Chrome Web Store listing, privacy text, and branding reviewed                                           |             |       |

## Package invariants

- Chrome-only Manifest V3
- `incognito: "not_allowed"`
- No notifications, host permissions, or `unlimitedStorage`
- `"commands"` is a top-level allowlisted object, never a permission array entry
- Production graph contains no workbench markers
