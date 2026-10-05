/** Catalog helpers. A risk-dependent operation gets an always-locked split twin `<key>#<suffix>` (§3.4). */

/** A valid access group (lowercase letters, digits, `.`, `_`, `-`) from any name; `fallback` if nothing is left. */
export function toGroup(name: string, fallback = 'misc'): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_')
      .replace(/^[^a-z0-9]+/, '') || fallback
  );
}

/** `cover.open_cover#garage` → `cover.open_cover`. */
export function baseKey(key: string): string {
  return key.split('#')[0]!;
}

/** `cover.open_cover#garage` → `garage`; undefined for a key without a suffix. */
export function splitSuffix(key: string): string | undefined {
  const i = key.indexOf('#');
  return i < 0 ? undefined : key.slice(i + 1);
}

/** `cover.open_cover` + `garage` → `cover.open_cover#garage`. */
export function withSplit(key: string, suffix: string): string {
  return `${baseKey(key)}#${suffix}`;
}
