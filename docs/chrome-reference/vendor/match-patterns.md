# Chrome match patterns — official reference extract

Source URL: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
Source title: Match patterns
Retrieved at (UTC): 2026-08-08T15:00:00Z
License: CC BY 4.0 documentation; Apache 2.0 code samples, as stated by the source page.

Chrome match patterns define the URL grammar used by extension host permissions and selected APIs. They are permission-scoping syntax, not a complete rule language.

The tab manager's nested expressions may support richer URL/path/title/opener/regex predicates, but host permissions must remain valid Chrome patterns and be minimized independently. Validate product-rule patterns in the Rule Engine; never pass an arbitrary rule expression where Chrome expects a match pattern.
