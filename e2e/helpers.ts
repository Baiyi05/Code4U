import { expect, type ConsoleMessage, type Page, type TestInfo } from '@playwright/test';

/**
 * Shared rig for the e2e specs.
 *
 * Three things every step gets: the response was not a 404, the page says what
 * it should, and nothing went to console.error. Plus a screenshot named after
 * the step, written to e2e/shots/<project>/NN-<step>.png and never read back
 * into the conversation.
 */

/** Noise no build of this app is responsible for. */
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[HMR\]/i,
  /Fast Refresh/i,
  // the dev server's hot-reload socket; the e2e run uses a production build
  /_next\/hmr/i,
  /favicon/i,
  // Wikimedia rate-limits image requests when a whole suite loads them at once
  /upload\.wikimedia\.org/i,
  /Failed to load resource: the server responded with a status of 429/i,
];

export class Journey {
  readonly errors: string[] = [];
  private step = 0;

  constructor(
    private readonly page: Page,
    private readonly info: TestInfo,
  ) {
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
      this.errors.push(text);
    });
    page.on('pageerror', (error) => {
      this.errors.push(`uncaught: ${error.message}`);
    });
  }

  /** Navigate and assert the response was real. */
  async go(path: string): Promise<void> {
    const response = await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(response, `no response for ${path}`).not.toBeNull();
    expect(response!.status(), `${path} returned ${response!.status()}`).toBeLessThan(400);
    await this.notFoundCheck(path);
  }

  /**
   * Did Next render its not-found page?
   *
   * This reads VISIBLE text, not the HTML: Next bundles the 404 component into
   * every page, so "This page could not be found" appears in the markup of
   * perfectly good pages. Only what a person can actually see counts, and the
   * pattern is the whole heading rather than a loose "404".
   */
  async notFoundCheck(where: string): Promise<void> {
    const visible = await this.page.locator('body').innerText();
    expect(visible, `${where} rendered Next's 404 page`).not.toMatch(
      /404\s*\|?\s*This page could not be found/i,
    );
  }

  /**
   * Close a step: assert the expected copy is on screen, no console errors have
   * piled up, and save a screenshot named for the step.
   */
  async check(name: string, expectedText: string | RegExp): Promise<void> {
    this.step += 1;
    const label = `${String(this.step).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

    // `visible=true` matters: Block Detail is rendered twice — a sheet below lg
    // and a column above it — and the one CSS hides is still in the DOM. Taking
    // .first() blindly grabs the hidden copy on a phone and fails on a page that
    // is perfectly correct.
    await expect(
      this.page.getByText(expectedText).locator('visible=true').first(),
      `"${name}": expected copy not visible`,
    ).toBeVisible();

    await this.notFoundCheck(name);

    await this.page.screenshot({
      path: `e2e/shots/${this.info.project.name}/${label}.png`,
      fullPage: true,
    });

    expect(this.errors, `"${name}" logged console errors:\n${this.errors.join('\n')}`).toEqual([]);
  }

  /** Where we are, without the origin. */
  url(): string {
    return new URL(this.page.url()).pathname + new URL(this.page.url()).search;
  }
}
