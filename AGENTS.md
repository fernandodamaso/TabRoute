# TabRoute project instructions

Before changing Chrome extension, tab, group, persistence, startup, or UI behavior, read [skills/chrome-tab-manager/SKILL.md](skills/chrome-tab-manager/SKILL.md) in full. The Phase 0 knowledge pack is a required gate before feature implementation.

For manager UI, fixture scenarios, isolated Chromium e2e, popup smoke, and live inspection, read [docs/agent-development-workbench.md](docs/agent-development-workbench.md). Use `npm run workbench`, `npm run workbench:real`, `npm run test:workbench`, `npm run test:extension`, and `npm run smoke:popup`. Never attach to the user's Chrome profile.

Keep the extension Chrome-only and Manifest V3 in v1. Do not add feature code, dependencies, or a manifest while the design specification is the only approved implementation artifact.
