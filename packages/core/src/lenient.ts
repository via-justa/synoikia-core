import type { z } from 'zod';

/** Parses stored JSON from an earlier release, dropping (and warning about) fields the schema now rejects
 * so their defaults apply; request input is still validated strictly. */
export function parseLeniently<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  label: string,
  warn: (message: string) => void = (m) => console.warn(`WARN ${m}`),
): z.infer<S> {
  return cleanStored(schema, raw, label, warn).value;
}

/** The lenient parse plus the stored value minus rejected fields (defaults aren't written in). */
export function cleanStored<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  label: string,
  warn: (message: string) => void = (m) => console.warn(`WARN ${m}`),
): { value: z.infer<S>; cleaned: unknown; dropped: string[] } {
  const cleaned: unknown = raw === null || raw === undefined ? {} : structuredClone(raw);
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const parsed = schema.safeParse(cleaned);
    if (parsed.success) return { value: parsed.data, cleaned, dropped };
    let progress = false;
    for (const issue of parsed.error.issues) {
      const path = issue.path.filter((p): p is string | number => typeof p !== 'symbol');
      if (path.length === 0 || !removeAt(cleaned, path)) continue;
      warn(`${label}: ignoring stored ${path.join('.')} (${issue.message}); using the default`);
      dropped.push(path.join('.'));
      progress = true;
    }
    if (!progress) break;
  }
  warn(`${label}: stored value is unusable; using defaults`);
  return { value: schema.parse({}), cleaned: {}, dropped: [...dropped, '*'] };
}

function removeAt(root: unknown, path: (string | number)[]): boolean {
  let node = root as Record<string | number, unknown> | undefined;
  for (const key of path.slice(0, -1)) {
    if (!node || typeof node !== 'object') return false;
    node = node[key] as Record<string | number, unknown> | undefined;
  }
  const last = path.at(-1)!;
  if (!node || typeof node !== 'object' || !(last in node)) return false;
  if (Array.isArray(node) && typeof last === 'number') node.splice(last, 1);
  else delete node[last];
  return true;
}
