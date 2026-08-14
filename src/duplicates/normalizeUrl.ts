import type { DuplicatePolicy, DuplicateSettings } from "../domain/types";
import type { TabSnapshot } from "../domain/types";
import { matchesPattern } from "../rules/patternMatcher";

export function isRoutableUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function stripTracking(url: URL, trackingParameters: readonly string[]): URL {
  const next = new URL(url.toString());
  for (const parameter of trackingParameters) {
    next.searchParams.delete(parameter);
  }
  return next;
}

export function normalizeUrl(
  url: string,
  settings: DuplicateSettings,
  options?: { dropFragment?: boolean }
): string {
  const parsed = new URL(url);
  const stripped = stripTracking(parsed, settings.trackingParameters);
  if (options?.dropFragment) stripped.hash = "";
  return stripped.toString();
}

export function buildDuplicateKey(
  tab: TabSnapshot,
  policy: DuplicatePolicy,
  settings: DuplicateSettings
): string | null {
  if (tab.routing.kind !== "routable") return null;
  const url = tab.routing.url;
  if (!url) return null;
  switch (policy.kind) {
    case "allow":
      return null;
    case "exactUrl":
      return normalizeUrl(url, settings);
    case "fragmentlessUrl":
      return normalizeUrl(url, settings, { dropFragment: true });
    case "domain":
      return new URL(url).hostname;
    case "urlAndTitle":
      return `${normalizeUrl(url, settings)}|${tab.title}`;
    case "pattern": {
      const normalized = normalizeUrl(url, settings);
      return matchesPattern(normalized, policy.pattern) ? policy.pattern : null;
    }
    default:
      return null;
  }
}

export function matchesExclusion(url: string, exclusions: readonly string[]): boolean {
  return exclusions.some((pattern) => url.includes(pattern));
}
