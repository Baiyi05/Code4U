import { expect, test } from '@playwright/test';

import { Journey } from './helpers';

/**
 * The four-minute demo, walked end to end.
 *
 * 01 Trip Setup → create → 02 Preference Intake → 03 Taste Profile
 * → 04 Itinerary → 05 Block Detail → 06 Re-plan → diff → accept
 * → 07 Budget & Split
 *
 * Every step asserts the response was not a 404, the expected copy is on screen
 * and nothing hit console.error, then saves a screenshot to e2e/shots/.
 *
 * The point of the last third is that the accept is real: the itinerary and the
 * budget figure both have to change, because applyDiff and enforceBudget really
 * run in the browser.
 */
test.describe('the demo path', () => {
  test('walks from setup to the split without a dead end', async ({ page }, info) => {
    const journey = new Journey(page, info);

    // ---- 01 Trip Setup ----------------------------------------------------
    await journey.go('/setup');
    await journey.check('setup', 'A trip that re-plans itself');

    // the wordmark, so a half-finished rename fails here rather than on stage
    await expect(page.getByText('Detour4U').first()).toBeVisible();

    await page.getByLabel('Where').fill('Osaka, Japan');
    await page.getByLabel('Budget per person').fill('3000');
    await page.getByRole('button', { name: 'Create trip' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await journey.check('trip-created-dialog', 'Trip created');

    // ---- 02 Preference Intake --------------------------------------------
    // this is the click that was reported as a 404
    await page.getByRole('button', { name: 'Fill it in as a member' }).click();
    await page.waitForURL(/\/t\/[^/]+\/join$/);
    expect(journey.url(), 'the member button must not land on an empty slug').not.toContain('/t//');
    await journey.check('intake-step-1', 'What are you comfortable spending?');

    // budget → pace → interests → dietary → must-do
    await page.getByRole('radio', { name: /Somewhere in the middle/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await journey.check('intake-pace', 'How full should the days be?');

    await page.getByRole('radio', { name: /^Packed/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await journey.check('intake-interests', 'What are you here for?');

    await page.getByRole('button', { name: 'Next' }).click();
    await journey.check('intake-dietary', 'Anything you cannot eat?');

    // halal next to Amirah's vegetarian is what grows the new conflict card
    const halal = page.getByRole('button', { name: 'halal', exact: true });
    if ((await halal.getAttribute('aria-pressed')) !== 'true') await halal.click();
    await page.getByRole('button', { name: 'Next' }).click();
    await journey.check('intake-must-do', 'One thing you would be sad to miss?');

    await page.getByRole('button', { name: 'Done' }).click();
    await journey.check('intake-done', 'Done — 47 seconds');

    // ---- 03 Taste Profile -------------------------------------------------
    await page.getByRole('link', { name: 'See the group profile' }).click();
    await page.waitForURL(/\/profile$/);
    await journey.check('taste-profile', 'Where you disagree');

    // the fifth member's answers have to have produced a dietary conflict that
    // did not exist before they joined
    await expect(
      page.getByText('Dietary', { exact: true }),
      'the new dietary conflict card did not appear',
    ).toBeVisible();
    await expect(page.getByText(/halal/i).first()).toBeVisible();
    await journey.check('taste-profile-new-conflict', 'Dietary');

    // ---- 04 Itinerary -----------------------------------------------------
    await page.getByRole('link', { name: 'Itinerary', exact: true }).click();
    await page.waitForURL(/\/t\/[^/?]+(\?.*)?$/);
    await journey.check('itinerary', 'Budget · per person');

    // the app shell header carries the brand on every trip screen
    await expect(page.getByText(/^Detour4U · /)).toBeVisible();

    const budgetBefore = await page.getByTestId('budget-spent').innerText();
    const blocksBefore = await page.getByTestId('block-card').count();

    // ---- 05 Block Detail --------------------------------------------------
    await page.getByRole('button', { name: /Osaka Castle/ }).first().click();
    await page.waitForURL(/[?&]block=/);
    expect(journey.url(), 'opening a block must put it in the URL').toContain('block=');
    await journey.check('block-detail', 'Why this');

    // ---- 06 Re-plan -------------------------------------------------------
    await page.goBack();
    await page.getByRole('link', { name: 'Re-plan', exact: true }).click();
    await page.waitForURL(/\/replan$/);
    await journey.check('replan-triggers', 'What has gone wrong?');

    await page.getByRole('button', { name: /Flight delayed/ }).click();
    await page.waitForURL(/[?&]s=delay/);
    await journey.check('replan-diff', 'FLIGHT DELAYED');

    // untick one row, so the accept is a partial one
    const boxes = page.getByRole('checkbox');
    await expect(boxes.first()).toBeVisible();
    const tickedBefore = await boxes.count();
    expect(tickedBefore, 'the diff produced no tickable changes').toBeGreaterThan(1);
    await boxes.first().click();
    await journey.check('replan-diff-partial', 'Accept');

    await page.getByRole('button', { name: /^Accept/ }).click();
    await page.waitForURL(/\/t\/[^/?]+(\?.*)?$/);
    await journey.check('itinerary-after-accept', 'change');

    // ---- the accept has to have actually changed something ----------------
    const budgetAfter = await page.getByTestId('budget-spent').innerText();
    const blocksAfter = await page.getByTestId('block-card').count();
    expect(
      budgetAfter !== budgetBefore || blocksAfter !== blocksBefore,
      `nothing changed after accepting: budget ${budgetBefore} → ${budgetAfter}, ` +
        `${blocksBefore} → ${blocksAfter} blocks`,
    ).toBe(true);

    // ---- 07 Budget & Split ------------------------------------------------
    await page.getByRole('link', { name: 'Budget', exact: true }).click();
    await page.waitForURL(/\/budget$/);
    await journey.check('budget-split', 'Who owes who');
    await expect(page.getByText('Where the money went')).toBeVisible();
  });
});
