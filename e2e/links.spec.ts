import { expect, test } from '@playwright/test';

import { demoSlug, resolvesAgainst, routePatterns } from './route-table';

/**
 * Every link the UI actually renders has to land somewhere real.
 *
 * This is the half of the route check that cannot be done by reading source:
 * the app shell builds its nav hrefs from variables, so the only way to know
 * where they point is to render the page and look.
 *
 * Nothing here is a hand-written route list — the pages to visit come from
 * globbing app/ ** /page.tsx, and the links come out of the DOM.
 */

const SLUG = demoSlug();
const PATTERNS = routePatterns();
const resolves = (path: string): boolean => resolvesAgainst(PATTERNS, path);

/** Every route on disk, with [slug] filled in. */
const PAGES = PATTERNS.map((p) => p.replace('[slug]', SLUG));

test.describe('links in the rendered DOM', () => {
  test('the route table came off disk', () => {
    expect(PATTERNS.length).toBeGreaterThanOrEqual(7);
    expect(PATTERNS).toContain('/t/[slug]/join');
  });

  for (const path of PAGES) {
    test(`every internal link on ${path} resolves`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), `${path} itself`).toBeLessThan(400);

      const hrefs = await page.$$eval('a[href]', (anchors) =>
        anchors.map((a) => a.getAttribute('href') ?? ''),
      );

      const internal = [
        ...new Set(
          hrefs
            .filter((h) => h.startsWith('/'))
            .filter((h) => !h.startsWith('/_next/'))
            .filter((h) => !/\.(png|jpe?g|svg|ico|json|css|js)(\?|$)/i.test(h)),
        ),
      ];

      const broken: string[] = [];
      for (const href of internal) {
        const pathname = href.split('?')[0] ?? '';
        if (!resolves(pathname)) {
          broken.push(`${href} — no route on disk`);
          continue;
        }
        // The status is the honest signal: Next bundles its 404 component into
        // every page, so sniffing the HTML for "could not be found" flags good
        // pages as broken. A missing route really does answer 404.
        const res = await page.request.get(href);
        if (res.status() >= 400) broken.push(`${href} — ${res.status()}`);
      }

      expect(broken, `on ${path}:\n${broken.join('\n')}`).toEqual([]);
    });
  }

  test('a page with a nav really does expose links, so an empty sweep cannot pass', async ({
    page,
  }) => {
    await page.goto(`/t/${SLUG}`);
    const hrefs = await page.$$eval('a[href]', (anchors) =>
      anchors.map((a) => a.getAttribute('href') ?? '').filter((h) => h.startsWith('/')),
    );
    expect(hrefs.length, 'the bottom nav should contribute four links').toBeGreaterThanOrEqual(4);
    expect(hrefs).toContain(`/t/${SLUG}/join`);
  });
});

test('a missing route really does answer 404, so this check can fail', async ({ page }) => {
  // without this, a change that made every request return 200 would make the
  // sweep above pass vacuously
  const res = await page.request.get(`/t/${SLUG}/definitely-not-a-route`);
  expect(res.status()).toBe(404);
  expect(resolves(`/t/${SLUG}/definitely-not-a-route`)).toBe(false);
});
