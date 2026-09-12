/**
 * lib/routes.test.ts — every navigation in the source points at a real route.
 *
 * The previous version of this check listed the routes by hand and fetched them,
 * which proves only that the routes I remembered exist. It cannot catch a button
 * pointing at a route that does not, which is the failure that actually bites.
 *
 * So nothing here is a hand-written route list:
 *
 *   - the route table is globbed off disk from app/ ** /page.tsx
 *   - router.push / replace / redirect targets are read out of the source
 *
 * This half runs with no server, so it stays in `npm test`. The other half —
 * every href in the rendered DOM of every route — needs a browser and lives in
 * e2e/links.spec.ts, because a nav bar that builds its hrefs from variables
 * cannot be checked by reading the source.
 */

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ROOT_DIR as ROOT,
  demoSlug,
  resolvesAgainst,
  routePatterns,
  walk,
} from '../e2e/route-table';
import { DEMO_TRIP } from './demo-data';

const SLUG = DEMO_TRIP.slug;
const PATTERNS = routePatterns();

const resolves = (path: string): boolean => resolvesAgainst(PATTERNS, path);

// ---------------------------------------------------------------------------
// Navigations that only happen on click
// ---------------------------------------------------------------------------

interface Target {
  file: string;
  raw: string;
  /** null when the template could not be resolved statically */
  path: string | null;
}

/**
 * router.push targets never reach the DOM, so they are read out of the source.
 *
 * Template holes are filled with what they actually hold at runtime; anything
 * still unresolved is reported rather than quietly skipped, so a new kind of
 * navigation cannot slip past by being unparseable.
 */
function programmaticTargets(): Target[] {
  const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))].filter((f) =>
    /\.tsx?$/.test(f),
  );

  const out: Target[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const calls = source.matchAll(
      /(?:router\.(?:push|replace)|redirect)\(\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g,
    );
    for (const call of calls) {
      const raw = call[1] ?? call[2] ?? call[3] ?? '';
      out.push({ file: relative(ROOT, file).split(sep).join('/'), raw, path: substitute(raw) });
    }
  }
  return out;
}

/** Fill in the template holes these targets use; null when we cannot. */
function substitute(raw: string): string | null {
  const filled = raw
    .replace(/\$\{DEMO_TRIP\.slug\}/g, SLUG)
    .replace(/\$\{pathname\}/g, `/t/${SLUG}/replan`)
    .replace(/\$\{base\}/g, `/t/${SLUG}`)
    .replace(/\$\{scenario\.disruption\.day\}/g, '1')
    .replace(/\$\{query\.toString\(\)\}/g, 's=delay')
    .replace(/\$\{picked\}/g, 'delay');
  return filled.includes('${') ? null : filled;
}

/**
 * The one navigation assembled entirely from variables. It is the itinerary's
 * own day/block query, covered end to end by e2e/demo-path.spec.ts.
 */
const ASSEMBLED_AT_RUNTIME = new Set(['url']);

// ---------------------------------------------------------------------------

describe('the route table', () => {
  it('is globbed off disk, not written down here', () => {
    expect(PATTERNS.length).toBeGreaterThanOrEqual(7);
    expect(PATTERNS).toContain('/t/[slug]/join');
    expect(PATTERNS).toContain('/setup');
  });

  it('matches and rejects the way Next does', () => {
    expect(resolves(`/t/${SLUG}/join`)).toBe(true);
    expect(resolves(`/t/${SLUG}`)).toBe(true);
    // the three shapes this check exists to catch
    expect(resolves('/t//join'), 'empty slug').toBe(false);
    expect(resolves(`/t/${SLUG}/intake`), 'wrong route name').toBe(false);
    expect(resolves(`/t/${SLUG}/join/extra`), 'too deep').toBe(false);
  });
});

describe('router.push, router.replace and redirect', () => {
  const targets = programmaticTargets();

  it('found the navigations at all', () => {
    expect(targets.length, 'the source scan found nothing — it is broken').toBeGreaterThan(4);
  });

  it('every one resolves to a route that exists', () => {
    const broken: string[] = [];
    for (const target of targets) {
      if (target.path === null) {
        if (ASSEMBLED_AT_RUNTIME.has(target.raw)) continue;
        broken.push(`${target.file}: could not resolve \`${target.raw}\``);
        continue;
      }
      const pathname = target.path.split('?')[0] ?? '';
      if (!resolves(pathname)) broken.push(`${target.file}: ${target.path} has no route on disk`);
    }
    expect(broken, `\n${broken.join('\n')}\n`).toEqual([]);
  });

  it('covers the Trip Setup dialog buttons by name', () => {
    // "Fill it in as a member" and "Skip to the itinerary" — the reported bug
    const setup = targets.filter((t) => t.file.includes('setup-screen'));
    expect(setup.map((t) => t.path)).toEqual(
      expect.arrayContaining([`/t/${SLUG}/join`, `/t/${SLUG}`]),
    );
  });

  it('would catch the slug going missing', () => {
    // the failure mode that produces /t//join
    expect(substitute('/t/${DEMO_TRIP.slug}/join')).toBe(`/t/${SLUG}/join`);
    expect(resolves('/t//join')).toBe(false);
    expect(SLUG).not.toBe('');
  });
});

describe('the slug the e2e specs use', () => {
  it('is the same one the app uses', () => {
    // Playwright cannot import demo-data (JSON import attributes), so it reads
    // the literal instead. If these ever disagree the e2e run is testing a trip
    // that does not exist.
    expect(demoSlug()).toBe(DEMO_TRIP.slug);
  });
});
