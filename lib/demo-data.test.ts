/**
 * lib/demo-data.test.ts — the prototype's demo data, and the diffs it ships with.
 *
 * This file does two jobs.
 *
 * 1. It proves the demo itinerary is legal by the trip's own rules, the same way
 *    seeds/osaka-trip.json has to be. Bad demo data is worse than no demo data.
 *
 * 2. It GENERATES the four re-plan diffs the UI shows. It feeds a fixed model
 *    reply to the real §8 engine and commits what comes out to demo-diffs.json.
 *    So the diffs on screen are the engine's, not mine — including the costs,
 *    the immovable set, the time window and the violations. Run
 *
 *      UPDATE_DEMO_DIFFS=1 npx vitest run lib/demo-data.test.ts
 *
 *    to regenerate; every other run re-derives them and fails if the committed
 *    file has drifted from what the engine now produces.
 *
 * The browser never does any of this. It reads demo-diffs.json and calls
 * applyDiff / enforceBudget, which is the whole of what runs client-side.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildConstraints,
  enforceBudget,
  filterCandidates,
  totalCost,
  validateItinerary,
} from './constraints';
import { buildCandidatePool } from './generate';
import { MockKnowledgeRetriever } from './__mocks__/knowledge';
import { MockLLMClient } from './__mocks__/llm';
import { MockPlaceRepository } from './__mocks__/places';
import { applyDiff, replan, type ReplanResult } from './replan';
import {
  DEMO_BLOCKS,
  DEMO_MEMBERS,
  DEMO_PLACES,
  DEMO_PREFERENCES,
  DEMO_SCENARIOS,
  DEMO_TRIP,
  JOINING_PREFERENCE,
  PLACE_KNOWLEDGE,
  PLACE_MEDIA,
  THUMB_WIDTHS,
  addressOf,
  citationFor,
  knowledgeFor,
  demoConstraints,
  diffFor,
  expensesOf,
  immovableIdsAt,
  mediaFor,
  replacementWhy,
  settleUp,
  thumbAt,
  type ScenarioKey,
} from './demo-data';
import type { Block, Place, ReplanOps } from './schemas';

const DIFFS_PATH = new URL('./demo-diffs.json', import.meta.url);
const constraints = demoConstraints();
const pool = buildCandidatePool(DEMO_PLACES, constraints);

function candidatesFor(day: number): Place[] {
  return filterCandidates(DEMO_PLACES, constraints, day);
}

// ---------------------------------------------------------------------------
// The scripted model replies
// ---------------------------------------------------------------------------

/**
 * What the model "says" for each scenario.
 *
 * These are the only hand-written part of the re-plan. Everything downstream —
 * whether the ops are legal, what each one costs, which blocks were off limits —
 * is worked out by lib/replan.ts. If one of these replies broke a rule, the
 * engine would void the whole batch and the assertions below would fail, which
 * is exactly the guarantee this file exists to provide.
 */
const REPLIES: Record<ScenarioKey, ReplanOps> = {
  delay: {
    summary: 'Day 1 rebuilt around a 12:30 landing.',
    budgetDelta: -35,
    ops: [
      {
        op: 'move',
        blockId: 'b01',
        to: { day: 1, startTime: '12:30', durationMin: 120 },
        note: 'The castle is the one thing that survives the delay — it just starts when you land.',
      },
      {
        op: 'remove',
        blockId: 'b02',
        note: 'You are still in the air at noon. A sit-down lunch inside the park no longer fits.',
      },
      {
        op: 'move',
        blockId: 'b03',
        to: { day: 1, startTime: '15:00', durationMin: 90 },
        note: 'Trimmed to 90 minutes so it still ends before the 17:00 close.',
      },
      {
        op: 'add',
        block: {
          day: 1,
          startTime: '16:45',
          durationMin: 75,
          title: 'Amerikamura at dusk',
          subtitle: 'Chuo · thrift blocks, ten minutes from the booked table',
          placeId: 'amerikamura',
          costPerPerson: 40,
          reason: {
            budget: 'RM 40 — RM 35 less than the lunch it replaces.',
            constraint: 'Open to 20:00 and a short walk from the Dotonbori booking.',
          },
        },
        note: 'Fills the gap the delay opened up, and walks you towards the locked dinner.',
      },
    ],
  },

  weather: {
    summary: 'Day 5 moved indoors.',
    budgetDelta: 40,
    ops: [
      {
        op: 'remove',
        blockId: 'b17',
        note: 'Shitennoji is open ground from the gate onwards — there is nothing to shelter under.',
      },
      {
        op: 'remove',
        blockId: 'b18',
        note: 'The garden is the entire reason to go, and it will be under water.',
      },
      {
        op: 'move',
        blockId: 'b19',
        to: { day: 5, startTime: '11:00', durationMin: 90 },
        note: 'Indoors already, so it moves up to hold the middle of the day together.',
      },
      {
        op: 'add',
        block: {
          day: 5,
          startTime: '09:30',
          durationMin: 90,
          title: 'Kuromon Ichiba market',
          subtitle: 'Namba · roofed the whole length',
          placeId: 'kuromon-ichiba',
          costPerPerson: 55,
          reason: {
            budget: 'RM 55 including breakfast, against RM 45 of tickets it replaces.',
            constraint: 'Fully covered, and it opens at 09:00.',
          },
        },
        note: 'A covered market is the closest thing to the morning you were going to have.',
      },
      {
        op: 'add',
        block: {
          day: 5,
          startTime: '14:00',
          durationMin: 90,
          title: 'Den Den Town',
          subtitle: 'Naniwa · arcades and electronics streets',
          placeId: 'den-den-town',
          costPerPerson: 30,
          reason: {
            budget: 'RM 30 · the cheapest indoor afternoon on the candidate list.',
            constraint: 'Indoors, and it runs to 20:00 if the rain holds you there.',
          },
        },
        note: 'Keeps the afternoon indoors without moving the locked dinner.',
      },
    ],
  },

  closed: {
    summary: 'The bay morning rebuilt without the aquarium.',
    budgetDelta: -105,
    ops: [
      {
        op: 'remove',
        blockId: 'b05',
        note: 'Kaiyukan is shut today. Nothing else at the bay replaces two and a half hours of it.',
      },
      {
        op: 'move',
        blockId: 'b07',
        to: { day: 2, startTime: '10:00', durationMin: 60 },
        note: 'The wheel opens at 10:00 and is now the reason to be at the bay at all.',
      },
      {
        op: 'move',
        blockId: 'b06',
        to: { day: 2, startTime: '11:30', durationMin: 60 },
        note: 'Lunch moves up an hour to follow the wheel rather than the aquarium.',
      },
      {
        op: 'add',
        block: {
          day: 2,
          startTime: '13:30',
          durationMin: 120,
          title: 'Osaka Science Museum',
          subtitle: 'Kita · planetarium under the same roof',
          placeId: 'osaka-science-museum',
          costPerPerson: 25,
          reason: {
            budget: 'RM 25 against the RM 130 aquarium ticket that fell through.',
            constraint: 'Open Tuesdays, unlike the history museum, and indoors.',
          },
        },
        note: 'Buys back the afternoon the closure took, at a fifth of the price.',
      },
    ],
  },

  overbudget: {
    summary: 'RM 290 taken off without touching a locked block.',
    budgetDelta: -290,
    ops: [
      {
        op: 'remove',
        blockId: 'b12',
        note: 'A RM 120 sit-down dinner at 20:00 after eleven hours in a theme park is the easiest cut on the plan.',
      },
      {
        op: 'remove',
        blockId: 'b16',
        note: 'The arcade is still worth walking; it does not have to be the RM 110 sit-down version.',
      },
      {
        op: 'remove',
        blockId: 'b19',
        note: 'Two paid observatories in five days, and this is the second one.',
      },
      {
        op: 'add',
        block: {
          day: 5,
          startTime: '14:00',
          durationMin: 90,
          title: 'Tsutenkaku, Shinsekai',
          subtitle: 'Naniwa · the older tower, and the neighbourhood around it',
          placeId: 'shinsekai-tsutenkaku',
          costPerPerson: 35,
          reason: {
            budget: 'RM 35 against RM 95 — the same view for a third of the money.',
            constraint: 'Open to 20:00, so it drops straight into the slot that opened up.',
          },
        },
        note: 'Keeps a view on the last afternoon while still handing back RM 60 of it.',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Running the engine
// ---------------------------------------------------------------------------

interface StoredDiff {
  ops: ReplanResult['ops'];
  budgetDelta: number;
  violations: ReplanResult['violations'];
  window: ReplanResult['window'];
  immovable: string[];
  movable: string[];
  citations: ReplanResult['citations'];
  source: ReplanResult['source'];
  /** overbudget only: how much per person had to come off */
  shortfall: number;
}

async function runScenario(key: ScenarioKey): Promise<ReplanResult> {
  const scenario = DEMO_SCENARIOS.find((s) => s.key === key)!;
  return replan(
    {
      trip: DEMO_TRIP,
      preferences: DEMO_PREFERENCES,
      blocks: DEMO_BLOCKS,
      disruption: scenario.disruption,
      now: scenario.now,
    },
    {
      llm: new MockLLMClient({ responses: [REPLIES[key]] }),
      places: new MockPlaceRepository(DEMO_PLACES),
      knowledge: new MockKnowledgeRetriever(),
    },
  );
}

function shortfallOf(key: ScenarioKey): number {
  const scenario = DEMO_SCENARIOS.find((s) => s.key === key)!;
  if (scenario.disruption.type !== 'overbudget') return 0;
  const target = scenario.disruption.payload?.target ?? constraints.budgetCeiling;
  return Math.max(0, totalCost(DEMO_BLOCKS) - target);
}

function store(key: ScenarioKey, result: ReplanResult): StoredDiff {
  return {
    ops: result.ops,
    budgetDelta: result.budgetDelta,
    violations: result.violations,
    window: result.window,
    immovable: result.immovable,
    movable: result.movable,
    citations: result.citations,
    source: result.source,
    shortfall: shortfallOf(key),
  };
}

const KEYS: ScenarioKey[] = ['delay', 'weather', 'closed', 'overbudget'];

// ---------------------------------------------------------------------------
// 1. The itinerary the prototype opens on
// ---------------------------------------------------------------------------

describe('the demo itinerary', () => {
  it('passes the trip’s own rules, exactly as the seed has to', () => {
    const { ok, violations } = validateItinerary(DEMO_BLOCKS, constraints, pool.all);
    expect(violations).toEqual([]);
    expect(ok).toBe(true);
  });

  it('sits inside the ceiling the preferences imply', () => {
    // high / low / mid / mid → the LOWEST band decides: 0.85 of RM 3,000
    expect(constraints.budgetCeiling).toBe(2550);
    expect(totalCost(DEMO_BLOCKS)).toBe(1880);
    expect(totalCost(DEMO_BLOCKS)).toBeLessThanOrEqual(constraints.budgetCeiling);
  });

  it('has something locked on every day a scenario touches', () => {
    const lockedDays = new Set(DEMO_BLOCKS.filter((b) => b.locked).map((b) => b.day));
    // one on each day a scenario reaches, so every diff can show the guard working
    expect([...lockedDays].sort()).toEqual([1, 2, 3, 5]);
    expect(DEMO_BLOCKS.filter((b) => b.locked).length).toBe(4);
  });

  it('gives every block all three reason lines', () => {
    for (const block of DEMO_BLOCKS) {
      expect(block.reason?.budget, `${block.id} budget`).toBeTruthy();
      expect(block.reason?.votes, `${block.id} votes`).toBeTruthy();
      expect(block.reason?.constraint, `${block.id} constraint`).toBeTruthy();
    }
  });

  it('only cites text the retrieval layer actually holds', () => {
    const cited = DEMO_BLOCKS.filter((b) => b.sourceCitation);
    expect(cited.length).toBeGreaterThanOrEqual(4);
    for (const block of cited) {
      expect(block.sourceCitation?.source).toMatch(/Wikivoyage/);
      expect(block.sourceCitation?.text.length).toBeGreaterThan(20);
    }
  });

  it('points every block at a place the candidate filter allows', () => {
    for (const block of DEMO_BLOCKS) {
      expect(pool.ids.has(block.placeId ?? ''), `${block.id} → ${block.placeId}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The diffs, straight out of the engine
// ---------------------------------------------------------------------------

describe('the four re-plan diffs', () => {
  it('all come back from the engine first time, with nothing voided', async () => {
    for (const key of KEYS) {
      const result = await runScenario(key);
      // 'llm' and not 'llm-retry' is the assertion that matters: a retry would
      // mean checkOps had voided the batch and the engine went round again.
      expect(result.source, `${key} source`).toBe('llm');
      expect(result.attempts, `${key} attempts`).toHaveLength(1);
      expect(result.attempts[0]?.error, `${key} attempt error`).toBeNull();
      expect(result.ops.length, `${key} ops`).toBeGreaterThan(0);
    }
  });

  it('never returns an op that touches a locked or past block', async () => {
    for (const key of KEYS) {
      const result = await runScenario(key);
      const immovable = new Set(result.immovable);
      for (const entry of result.ops) {
        const target = entry.op.op === 'add' ? null : entry.op.blockId;
        if (target !== null) expect(immovable.has(target), `${key} → ${target}`).toBe(false);
      }
    }
  });

  it('prices every op itself rather than trusting the model’s figure', async () => {
    const result = await runScenario('delay');
    const removed = result.ops.find((o) => o.op.op === 'remove');
    // b02 costs RM 75, so removing it is worth exactly that much
    expect(removed?.costDelta).toBe(-75);
    const added = result.ops.find((o) => o.op.op === 'add');
    expect(added?.costDelta).toBe(40);
    expect(result.budgetDelta).toBe(-35);
  });

  it('gives the weather scenario indoor replacements only', async () => {
    const result = await runScenario('weather');
    const added = result.ops.filter((o) => o.op.op === 'add');
    expect(added.length).toBeGreaterThan(0);
    for (const entry of added) {
      const op = entry.op;
      if (op.op !== 'add') continue;
      const place = DEMO_PLACES.find((p) => p.id === op.block.placeId);
      expect(place?.indoor, `${place?.id} must be indoors`).toBe(true);
    }
  });

  it('drops the closed place out of the candidates it may replace with', async () => {
    const result = await runScenario('closed');
    for (const entry of result.ops) {
      if (entry.op.op !== 'add') continue;
      expect(entry.op.block.placeId).not.toBe('kaiyukan');
    }
  });

  it('closes the overbudget gap without reaching for a locked block', async () => {
    const result = await runScenario('overbudget');
    const shortfall = shortfallOf('overbudget');
    expect(shortfall).toBe(280);
    // the ops have to save at least the shortfall, or the engine reports it
    expect(-result.budgetDelta).toBeGreaterThanOrEqual(shortfall);
    expect(result.violations.map((v) => v.code)).not.toContain('still_over_budget');
    // USJ at RM 420 is the most expensive block in the trip and is locked, so it
    // is not on the table however tight the budget gets
    expect(result.immovable).toContain('b09');
    expect(result.movable).not.toContain('b09');
  });

  it('leaves a legal itinerary once the whole diff is applied', async () => {
    for (const key of KEYS) {
      const scenario = DEMO_SCENARIOS.find((s) => s.key === key)!;
      const result = await runScenario(key);
      const applied = applyDiff(DEMO_BLOCKS, result.ops, {
        tripId: DEMO_TRIP.id,
        immovableIds: immovableIdsAt(DEMO_BLOCKS, scenario.now),
      });
      expect(applied.violations, `${key} refusals`).toEqual([]);

      const candidates = [...pool.all];
      const { violations } = validateItinerary(applied.blocks, constraints, candidates);
      expect(violations, `${key} result`).toEqual([]);
    }
  });

  it('leaves every locked block untouched after applying', async () => {
    const locked = DEMO_BLOCKS.filter((b) => b.locked);
    for (const key of KEYS) {
      const scenario = DEMO_SCENARIOS.find((s) => s.key === key)!;
      const result = await runScenario(key);
      const applied = applyDiff(DEMO_BLOCKS, result.ops, {
        immovableIds: immovableIdsAt(DEMO_BLOCKS, scenario.now),
      });
      for (const before of locked) {
        const after = applied.blocks.find((b) => b.id === before.id);
        expect(after, `${key}: ${before.id} survived`).toBeDefined();
        expect(after?.day).toBe(before.day);
        expect(after?.startTime).toBe(before.startTime);
        expect(after?.costPerPerson).toBe(before.costPerPerson);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. demo-diffs.json — generated here, read by the browser
// ---------------------------------------------------------------------------

describe('demo-diffs.json', () => {
  it('matches what the engine produces right now', async () => {
    const generated: Record<string, StoredDiff> = {};
    for (const key of KEYS) {
      generated[key] = store(key, await runScenario(key));
    }
    const serialised = `${JSON.stringify(generated, null, 2)}\n`;

    if (process.env['UPDATE_DEMO_DIFFS']) {
      writeFileSync(DIFFS_PATH, serialised, 'utf8');
    }

    let committed: string;
    try {
      committed = readFileSync(DIFFS_PATH, 'utf8');
    } catch {
      throw new Error(
        'lib/demo-diffs.json is missing. Regenerate it with:\n' +
          '  UPDATE_DEMO_DIFFS=1 npx vitest run lib/demo-data.test.ts',
      );
    }

    expect(
      JSON.parse(committed),
      'the committed diffs have drifted from the engine — regenerate with UPDATE_DEMO_DIFFS=1',
    ).toEqual(generated);
  });
});

// ---------------------------------------------------------------------------
// 4. What the browser does with them
// ---------------------------------------------------------------------------

describe('accepting part of a diff', () => {
  it('charges only for the ops that were ticked', async () => {
    const result = await runScenario('overbudget');
    const first = result.ops[0]!;
    const applied = applyDiff(DEMO_BLOCKS, [first], {
      immovableIds: immovableIdsAt(DEMO_BLOCKS, { day: 2, time: '12:00' }),
    });
    expect(applied.budgetDelta).toBe(first.costDelta);
    expect(applied.budgetDelta).not.toBe(result.budgetDelta);
  });

  it('refuses an op the browser posts back against a block the captain has since locked', async () => {
    const result = await runScenario('delay');
    const move = result.ops.find((o) => o.op.op === 'move')!;
    const lockedNow = DEMO_BLOCKS.map((b) => (b.id === 'b01' ? { ...b, locked: true } : b));

    const applied = applyDiff(lockedNow, [move], {
      immovableIds: immovableIdsAt(lockedNow, { day: 1, time: '09:00' }),
    });
    expect(applied.violations.map((v) => v.code)).toContain('immovable_block');
    expect(applied.blocks.find((b) => b.id === 'b01')?.startTime).toBe('09:30');
  });

  it('lets the budget guard finish the job when only some ops are ticked', async () => {
    const result = await runScenario('overbudget');
    const target = 1600;
    // tick only the first cut: RM 120 off a RM 280 gap
    const applied = applyDiff(DEMO_BLOCKS, result.ops.slice(0, 1));
    expect(totalCost(applied.blocks)).toBeGreaterThan(target);

    const guarded = enforceBudget(applied.blocks, { ...constraints, budgetCeiling: target });
    expect(totalCost(guarded)).toBeLessThanOrEqual(target);
    // and it still refuses to take the locked ones, whatever the target
    for (const id of ['b04', 'b09', 'b20']) {
      expect(guarded.some((b) => b.id === id), `${id} survived the guard`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The other screens
// ---------------------------------------------------------------------------

describe('the fifth member joining', () => {
  it('adds a dietary conflict that does not exist before they answer', () => {
    const before = buildConstraints(DEMO_TRIP, DEMO_PREFERENCES);
    const after = buildConstraints(DEMO_TRIP, [...DEMO_PREFERENCES, JOINING_PREFERENCE]);
    expect(before.requiredTags).not.toContain('halal');
    expect(after.requiredTags).toContain('halal');
    expect(after.requiredTags).toContain('vegetarian');
  });

  it('does not move the ceiling, so nothing already booked falls over', () => {
    const after = buildConstraints(DEMO_TRIP, [...DEMO_PREFERENCES, JOINING_PREFERENCE]);
    // 'mid' is above the 'low' band Amirah already set, so the ceiling holds
    expect(after.budgetCeiling).toBe(2550);
  });

  it('raises exactly one new thing for the captain: an unscheduled must-do', () => {
    const after = buildConstraints(DEMO_TRIP, [...DEMO_PREFERENCES, JOINING_PREFERENCE]);
    const { violations } = validateItinerary(DEMO_BLOCKS, after, pool.all);

    // Nabil's must-do is not on the plan, and the rule engine says so rather than
    // letting it slide. The Taste Profile screen surfaces this as a conflict the
    // captain can act on — it is a finding, not a broken itinerary.
    expect(violations.map((v) => v.code)).toEqual(['missing_forced']);
    expect(violations[0]?.message).toMatch(/kuromon/i);

    // and everything that was already true stays true
    const before = validateItinerary(DEMO_BLOCKS, buildConstraints(DEMO_TRIP, DEMO_PREFERENCES), pool.all);
    expect(before.violations).toEqual([]);
  });
});

describe('budget and split', () => {
  it('settles up to nothing owed', () => {
    const expenses = expensesOf(DEMO_BLOCKS);
    const transfers = settleUp(expenses, DEMO_MEMBERS);
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    expect(total).toBe(totalCost(DEMO_BLOCKS) * DEMO_MEMBERS.length);

    const net = new Map(DEMO_MEMBERS.map((m) => [m.id, 0]));
    for (const t of transfers) {
      net.set(t.fromId, (net.get(t.fromId) ?? 0) + t.amount);
      net.set(t.toId, (net.get(t.toId) ?? 0) - t.amount);
    }
    for (const expense of expenses) {
      net.set(expense.payerId, (net.get(expense.payerId) ?? 0) + expense.amount);
    }
    // everybody ends up having paid the same share
    for (const [, value] of net) expect(Math.round(value)).toBe(Math.round(total / DEMO_MEMBERS.length));
  });

  it('follows the itinerary when a re-plan changes it', async () => {
    const result = await runScenario('overbudget');
    const applied = applyDiff(DEMO_BLOCKS, result.ops);
    const after = expensesOf(applied.blocks);
    expect(after.reduce((s, e) => s + e.amount, 0)).toBe(
      totalCost(applied.blocks) * DEMO_MEMBERS.length,
    );
  });
});

describe('the candidate list a day at a time', () => {
  it('drops the places that are shut on the day in question', () => {
    // day 2 is a Tuesday: the history museum and the ramen museum both close
    const day2 = candidatesFor(2).map((p) => p.id);
    expect(day2).not.toContain('osaka-museum-history');
    expect(day2).not.toContain('instant-ramen-museum');
    // day 1 is a Monday: the two art/science museums close instead
    const day1 = candidatesFor(1).map((p) => p.id);
    expect(day1).not.toContain('nmao');
    expect(day1).not.toContain('osaka-science-museum');
  });

  it('keeps every place the itinerary uses in the union across days', () => {
    const used = new Set(DEMO_BLOCKS.map((b: Block) => b.placeId).filter(Boolean));
    for (const id of used) expect(pool.ids.has(String(id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Photos and addresses
// ---------------------------------------------------------------------------

describe('place photos', () => {
  it('covers every place the itinerary and the diffs can reach', () => {
    const needed = new Set<string>();
    for (const block of DEMO_BLOCKS) if (block.placeId) needed.add(block.placeId);
    for (const key of KEYS) {
      for (const entry of diffFor(key).ops) {
        if (entry.op.op === 'add') needed.add(entry.op.block.placeId);
      }
    }
    for (const id of needed) {
      expect(PLACE_MEDIA[id], `no photo for ${id}`).toBeDefined();
    }
  });

  it('only ships freely licensed photos, with the photographer named', () => {
    for (const [id, media] of Object.entries(PLACE_MEDIA)) {
      expect(media.license, `${id} licence`).toMatch(/^(CC|Public domain)/i);
      expect(media.fileUrl, `${id} file page`).toContain('commons.wikimedia.org');
      // the credit line has to be able to say who took it
      expect(media.artist ?? '', `${id} artist`).not.toBe('');
    }
  });

  it('stores URLs at a width Commons will actually serve', () => {
    for (const [id, media] of Object.entries(PLACE_MEDIA)) {
      expect(media.imageUrl, `${id} host`).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
      expect(media.imageUrl, `${id} no query string`).not.toContain('?');
      const width = Number(/\/(\d+)px-/.exec(media.imageUrl)?.[1]);
      expect(THUMB_WIDTHS).toContain(width);
    }
  });

  it('rounds a requested thumbnail up to a width Commons renders', () => {
    const url = PLACE_MEDIA['osaka-castle']!.imageUrl;
    // Commons answers 400 for anything off the bucket list, so 64 must not go out as 64
    expect(thumbAt(url, 64)).toContain('/120px-');
    expect(thumbAt(url, 120)).toContain('/120px-');
    expect(thumbAt(url, 121)).toContain('/250px-');
    expect(thumbAt(url, 960)).toContain('/960px-');
    expect(thumbAt(url, 5000)).toContain('/1920px-');
    expect(thumbAt('not-a-thumb-url', 120)).toBe('not-a-thumb-url');
  });

  it('gives every block on the plan an address to show', () => {
    for (const block of DEMO_BLOCKS) {
      expect(addressOf(block), `${block.id} address`).toBeTruthy();
      expect(addressOf(block), `${block.id} address`).toMatch(/Osaka|Minoh|Ikeda|Suita|Toyonaka/);
    }
  });

  it('resolves a re-plan’s added blocks too, which is why media is keyed by place', async () => {
    const result = await runScenario('weather');
    const applied = applyDiff(DEMO_BLOCKS, result.ops, { tripId: DEMO_TRIP.id });
    // applyDiff rebuilds added blocks field by field, so anything hung off the
    // block object would be lost here. Keying on placeId is what survives.
    for (const block of applied.blocks) {
      expect(mediaFor(block)?.imageUrl, `${block.id} → ${block.placeId}`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Why a replacement was picked
// ---------------------------------------------------------------------------

describe('replacementWhy', () => {
  const blocksById = new Map(DEMO_BLOCKS.map((b) => [b.id, b]));

  it('fills all four rows for every added block in every diff', () => {
    for (const key of KEYS) {
      const scenario = DEMO_SCENARIOS.find((s) => s.key === key)!;
      const diff = diffFor(key);
      const adds = diff.ops.filter((o) => o.op.op === 'add');
      expect(adds.length, `${key} has an added block`).toBeGreaterThan(0);

      for (const entry of adds) {
        const why = replacementWhy(entry, scenario, diff, DEMO_PREFERENCES, DEMO_MEMBERS, blocksById);
        expect(why, `${key} ${entry.id}`).not.toBeNull();
        expect(why!.constraint.length, `${key} constraint`).toBeGreaterThan(20);
        expect(why!.budget, `${key} budget`).toMatch(/RM/);
        expect(why!.votes.length, `${key} votes`).toBeGreaterThan(10);
        // A citation has to be about THIS place — either a chunk the engine
        // retrieved for this diff, or what the corpus holds about the place
        // itself. Matching on district or tag was tried and produced quotes
        // about the wrong landmark, which is the failure this guards.
        if (why!.source) {
          const placeId = entry.op.op === 'add' ? entry.op.block.placeId : '';
          const own = knowledgeFor(placeId);
          const fromDiff = diff.citations.includes(why!.source);
          expect(fromDiff || why!.source === own, `${key} ${entry.id} citation provenance`).toBe(
            true,
          );
        }
      }
    }
  });

  it('names the disruption rather than giving a generic reason', () => {
    const cases: Array<[ScenarioKey, RegExp]> = [
      ['delay', /cannot start before/i],
      ['weather', /rain/i],
      ['closed', /closed on day/i],
      ['overbudget', /had to come off/i],
    ];
    for (const [key, pattern] of cases) {
      const scenario = DEMO_SCENARIOS.find((s) => s.key === key)!;
      const diff = diffFor(key);
      const add = diff.ops.find((o) => o.op.op === 'add')!;
      const why = replacementWhy(add, scenario, diff, DEMO_PREFERENCES, DEMO_MEMBERS, blocksById)!;
      expect(why.constraint, key).toMatch(pattern);
    }
  });

  it('credits a real interest when there is one, and says so plainly when there is not', () => {
    const scenario = DEMO_SCENARIOS.find((s) => s.key === 'weather')!;
    const diff = diffFor('weather');
    const kuromon = diff.ops.find(
      (o) => o.op.op === 'add' && o.op.block.placeId === 'kuromon-ichiba',
    )!;
    const why = replacementWhy(kuromon, scenario, diff, DEMO_PREFERENCES, DEMO_MEMBERS, blocksById)!;
    // Jia asked for street food; a covered market answers that
    expect(why.votes).toMatch(/Jia/);

    // and with nobody's interests to match, it does not pretend otherwise
    const noInterests = DEMO_PREFERENCES.map((p) => ({ ...p, interests: [], mustDo: null }));
    const bare = replacementWhy(kuromon, scenario, diff, noInterests, DEMO_MEMBERS, blocksById)!;
    expect(bare.votes).toMatch(/Nobody asked/);
  });

  it('returns nothing for ops that are not additions', () => {
    const diff = diffFor('overbudget');
    const scenario = DEMO_SCENARIOS.find((s) => s.key === 'overbudget')!;
    const removal = diff.ops.find((o) => o.op.op === 'remove')!;
    expect(
      replacementWhy(removal, scenario, diff, DEMO_PREFERENCES, DEMO_MEMBERS, blocksById),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Installable on a phone
// ---------------------------------------------------------------------------

describe('the web app manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'),
  );

  it('points at icons that are really there', () => {
    expect(manifest.name).toContain('Detour4U');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/setup');

    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');

    for (const icon of manifest.icons) {
      const file = readFileSync(new URL(`../public${icon.src}`, import.meta.url));
      // a real PNG, not a placeholder
      expect(file.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(file.length).toBeGreaterThan(500);
    }
  });

  it('keeps every shortcut pointing at a route that exists', () => {
    for (const shortcut of manifest.shortcuts ?? []) {
      expect(shortcut.url).toMatch(new RegExp(`^/t/${DEMO_TRIP.slug}`));
    }
  });
});

describe('what the corpus holds about each place', () => {
  const flatten = (text: string): string =>
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');

  it('files every entry under a place its own text actually names', () => {
    for (const [id, chunk] of Object.entries(PLACE_KNOWLEDGE)) {
      const place = DEMO_PLACES.find((p) => p.id === id);
      expect(place, `${id} is a real place`).toBeDefined();
      const longest = place!.name
        .split(/[^\p{L}\p{N}]+/u)
        .map(flatten)
        .filter((w) => w.length >= 5)
        .sort((a, b) => b.length - a.length)[0];
      // an entry filed under the wrong place is worse than no entry at all
      expect(flatten(chunk.chunk), `${id} names itself`).toContain(longest);
      expect(chunk.source, `${id} source`).toMatch(/^Wikipedia \//);
      expect(chunk.url, `${id} url`).toMatch(/^https:\/\/en\.wikipedia\.org\//);
    }
  });

  it('has nothing to say about places nobody has written up, and says nothing', () => {
    // there is no English Wikipedia article for Kuromon Ichiba, so the row on
    // screen stays empty rather than quoting a sentence about the next street
    expect(knowledgeFor('kuromon-ichiba')).toBeNull();
    expect(knowledgeFor('not-a-place')).toBeNull();
  });

  it('prefers what the pipeline attached over what we hold', () => {
    const cited = DEMO_BLOCKS.find((b) => b.sourceCitation)!;
    expect(citationFor(cited)).toBe(cited.sourceCitation);

    const uncited = DEMO_BLOCKS.find((b) => !b.sourceCitation && PLACE_KNOWLEDGE[b.placeId ?? ''])!;
    expect(citationFor(uncited)?.source).toMatch(/^Wikipedia \//);
  });
});
