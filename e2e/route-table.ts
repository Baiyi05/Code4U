/**
 * e2e/route-table.ts — what routes actually exist, read off disk.
 *
 * Shared by lib/routes.test.ts (which checks router.push targets without a
 * browser) and e2e/links.spec.ts (which checks rendered hrefs with one). It
 * lives outside both so neither imports the other's test file.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** '/t/[slug]/join' for every page.tsx under app/, with (groups) removed. */
export function routePatterns(): string[] {
  return walk(join(ROOT, 'app'))
    .filter((f) => f.endsWith(`${sep}page.tsx`))
    .map((f) => {
      const rel = relative(join(ROOT, 'app'), f).split(sep).slice(0, -1);
      const segments = rel.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
      return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
    })
    .sort();
}

/**
 * Split a path into segments WITHOUT dropping empty ones.
 *
 * Filtering blanks out is what lets '/t//join' look like a match for
 * '/t/[slug]' — an empty slug is one of the shapes this exists to catch, so the
 * blank has to survive the split.
 */
export function segmentsOf(path: string): string[] {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? [] : trimmed.split('/').slice(1);
}

/** Does this URL path match a route on disk? */
export function resolvesAgainst(patterns: readonly string[], path: string): boolean {
  const parts = segmentsOf(path);
  return patterns.some((pattern) => {
    const want = segmentsOf(pattern);
    if (want.length !== parts.length) return false;
    return want.every((segment, i) =>
      segment.startsWith('[') && segment.endsWith(']')
        ? (parts[i] ?? '') !== ''
        : segment === parts[i],
    );
  });
}

export const ROOT_DIR = ROOT;

/**
 * The demo trip's slug, read out of lib/demo-data.ts.
 *
 * Playwright's TypeScript loader will not import the JSON that demo-data pulls
 * in, so the e2e specs cannot import the module itself. Reading the literal
 * keeps the slug in one place rather than hardcoding it twice, and
 * lib/routes.test.ts asserts this agrees with DEMO_TRIP.slug.
 */
export function demoSlug(): string {
  const source = readFileSync(join(ROOT, 'lib', 'demo-data.ts'), 'utf8');
  const match = /slug:\s*'([^']+)'/.exec(source);
  if (!match?.[1]) throw new Error('could not read the demo trip slug from lib/demo-data.ts');
  return match[1];
}
