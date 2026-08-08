# Official source snapshots

Phase 0 intentionally keeps official-source facts separate from the project interpretation in `../notes/`. The files named by `../sources.json` are required deliverables before feature code is introduced.

Each file begins with this metadata, followed by a compact, attributed reference extract of the official page:

```markdown
Source URL: https://developer.chrome.com/...
Source title: ...
Retrieved at (UTC): 2026-08-08T00:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.
```

The future updater records the raw source-content SHA-256 in `../sources.json`; it avoids a self-referential hash inside the Markdown extract. Never treat an extract as timeless. Refresh the relevant source from the allowlist before relying on a Chrome API detail that may have changed.
