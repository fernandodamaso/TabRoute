import { normalizeUrl } from "../duplicates/normalizeUrl";
import type { DuplicateSettings } from "../domain/types";

export function deriveCanonicalUrl(
  url: string,
  settings: DuplicateSettings
): string {
  return normalizeUrl(url, settings, { dropFragment: true });
}

export function isValidCanonicalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function matchesAcceptedPattern(url: string, pattern: string): boolean {
  if (url === pattern) return true;
  if (pattern.endsWith("*")) {
    return url.startsWith(pattern.slice(0, -1));
  }
  return url === pattern;
}

export function matchesAcceptedUrl(
  url: string,
  canonicalUrl: string,
  acceptedPatterns: readonly string[]
): boolean {
  if (url === canonicalUrl) return true;
  return acceptedPatterns.some((pattern) =>
    matchesAcceptedPattern(url, pattern)
  );
}
