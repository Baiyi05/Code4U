import { describe, expect, it } from 'vitest';

import { buildConstraints } from './constraints';
import type { GenerateDeps } from './generate';
import {
  applyDiff,
  checkOps,
  costDeltaOf,
  hasPassed,
  replan,
  ruleLayer,
  scopeDayFor,
  splitByMovability,
  MAX_OVERBUDGET_OPS,
  type ReplanInput,
  type TripNow,
} from './replan';
import { MockKnowledgeRetriever } from './__mocks__/knowledge';
import { MockLLMClient } from './__mocks__/llm';
import { MockPlaceRepository } from './__mocks__/places';
import { SEED_PLACES } from './seed';
import type { Block, DiffOp, Disruption, Preference, ReplanOp, Trip, ViolationCode } from './schemas';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 2026-09-07 (Mon) – 09-11 (Fri) */
const TRIP: Trip = {
  id: 'trip-1',
  slug: 'OSK-1',
  destination: 'Osaka, Japan',
  cityKey: 'osaka',
  startDate: '2026-09-07',
  endDate: '2026-09-11',
  budgetPerPerson: 1000,
  timezone: 'Asia/Tokyo',
};

const PREFS: Preference[] = [
  {
    memberId: 'm1',
    tripId: TRIP.id,
    budgetBand: 'high', // ceiling == budgetPerPerson
    pace: 'balanced',
    interests: null,
    dietary: null,
    mustDo: null,
    noGo: null,
  },
];

function block(over: Partial<Block> & Pick<Block, 'id' | 'day' | 'startTime'>): Block {
  return {
    tripId: TRIP.id,
    durationMin: 60,
    title: `Block ${over.id}`,
    subtitle: null,
    placeId: 'dotonbori',
    costPerPerson: 0,
    locked: false,
    reason: null,
    sourceCitation: null,
    createdBy: 'ai',
    ...over,
  };
}

/** Day 2, four blocks: one locked, one already past, two free. */
const DAY2: Block[] = [
  block({ id: 'past', day: 2, startTime: '09:00', placeId: 'osaka-castle', costPerPerson: 25 }),
  block({ id: 'locked', day: 2, startTime: '12:00', placeId: 'kaiyukan', costPerPerson: 75, locked: true }),
  block({ id: 'free-a', day: 2, startTime: '15:00', placeId: 'abeno-harukas', costPerPerson: 55 }),
  block({ id: 'free-b', day: 2, startTime: '18:00', placeId: 'dotonbori', costPerPerson: 60 }),
];

const OTHER_DAYS: Block[] = [
  block({ id: 'd1-a', day: 1, startTime: '10:00', placeId: 'shitennoji', costPerPerson: 15 }),
  block({ id: 'd3-a', day: 3, startTime: '10:00', placeId: 'usj', costPerPerson: 260 }),
  block({ id: 'd3-b', day: 3, startTime: '16:00', placeId: 'umeda-sky-building', costPerPerson: 45 }),
  block({ id: 'd4-a', day: 4, startTime: '10:00', placeId: 'nmao', costPerPerson: 30 }),
];

const ALL_BLOCKS: Block[] = [...OTHER_DAYS, ...DAY2];

/** Day 2, 14:00 — 'past' has started, the rest have not. */
const NOW: TripNow = { day: 2, time: '14:00' };

function deps(over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    llm: new MockLLMClient(),
    places: new MockPlaceRepository(),
    knowledge: new MockKnowledgeRetriever(),
    ...over,
  };
}

function input(over: Partial<ReplanInput> = {}): ReplanInput {
  return {
    trip: TRIP,
    preferences: PREFS,
    blocks: ALL_BLOCKS,
    disruption: { type: 'delay', day: 2, payload: { hours: 2 } },
    now: NOW,
    ...over,
  };
}

function ops(...list: ReplanOp[]): { ops: ReplanOp[] } {
  return { ops: list };
}

function codes(violations: ReadonlyArray<{ code: ViolationCode }>): ViolationCode[] {
  return violations.map((v) => v.code);
}

function opIds(diffOps: readonly DiffOp[]): string[] {
  return diffOps.map((d) => (d.op.op === 'add' ? `add:${d.op.block.placeId}` : d.op.blockId));
}

const CONSTRAINTS = buildConstraints(TRIP, PREFS);

// ---------------------------------------------------------------------------
// §8 step 2 — what can and cannot move
// ---------------------------------------------------------------------------

describe('splitByMovability', () => {
  it('puts locked and already-past blocks in the same immovable pile', () => {
    const { movable, immovable } = splitByMovability(ALL_BLOCKS, NOW, 2);
    expect(immovable.map((b) => b.id).sort()).toEqual(['locked', 'past']);
    expect(movable.map((b) => b.id)).toEqual(['free-a', 'free-b']);
  });

  it('scopes to one day for delay, weather and closed', () => {
    const { movable } = splitByMovability(ALL_BLOCKS, NOW, 2);
    expect(movable.every((b) => b.day === 2)).toBe(true);
  });

  it('spans every remaining day when the scope is null', () => {
    const { movable, immovable } = splitByMovability(ALL_BLOCKS, NOW, null);
    // day 1 is behind us entirely; day 2's past and locked blocks stay immovable
    expect(movable.map((b) => b.id)).toEqual(['free-a', 'free-b', 'd3-a', 'd3-b', 'd4-a']);
    expect(immovable.map((b) => b.id)).toEqual(['past', 'locked']);
    expect(movable.some((b) => b.id === 'd1-a')).toBe(false);
  });

  it('reads "past" off the clock it was given, not the system one', () => {
    const early: TripNow = { day: 2, time: '08:00' };
    expect(hasPassed(DAY2[0]!, early)).toBe(false);
    expect(hasPassed(DAY2[0]!, NOW)).toBe(true);
    // a block on an earlier day has passed whatever the time
    expect(hasPassed(OTHER_DAYS[0]!, NOW)).toBe(true);
  });
});

describe('scopeDayFor', () => {
  it('confines delay, weather and closed to the disruption day', () => {
    expect(scopeDayFor('delay', 2)).toBe(2);
    expect(scopeDayFor('weather', 2)).toBe(2);
    expect(scopeDayFor('closed', 2)).toBe(2);
  });

  it('lets overbudget reach every day still ahead', () => {
    expect(scopeDayFor('overbudget', 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §8 step 3 — the rule layer, one case per type
// ---------------------------------------------------------------------------

describe('ruleLayer', () => {
  function ctx(disruption: Disruption, movable = DAY2.slice(2)) {
    return {
      disruption,
      constraints: CONSTRAINTS,
      now: NOW,
      allBlocks: ALL_BLOCKS,
      movable,
      immovable: DAY2.slice(0, 2),
      candidates: SEED_PLACES,
    };
  }

  it('delay: pushes the earliest start out by payload.hours', () => {
    const out = ruleLayer(ctx({ type: 'delay', day: 2, payload: { hours: 2 } }));
    // now is 14:00 and the first movable block is at 15:00, so 15:00 + 2h
    expect(out.window.earliestStart).toBe('17:00');
    expect(out.window.day).toBe(2);
    expect(out.goal).toContain('2 hour(s) later');
  });

  it('delay: a fractional shift still lands on a real clock time', () => {
    const out = ruleLayer(ctx({ type: 'delay', day: 2, payload: { hours: 1.5 } }));
    expect(out.window.earliestStart).toBe('16:30');
  });

  it('weather: strips every outdoor candidate', () => {
    const out = ruleLayer(ctx({ type: 'weather', day: 2, payload: { condition: 'heavy rain' } }));

    expect(out.candidates.length).toBeGreaterThan(0);
    expect(out.candidates.every((p) => p.indoor === true)).toBe(true);
    // and the fixture really does contain outdoor places that had to be removed
    expect(SEED_PLACES.some((p) => p.indoor === false)).toBe(true);
    expect(out.candidates.some((p) => p.id === 'dotonbori')).toBe(false);
  });

  it('closed: strips exactly the place that shut', () => {
    const out = ruleLayer(ctx({ type: 'closed', day: 2, payload: { placeId: 'kaiyukan' } }));
    expect(out.candidates.some((p) => p.id === 'kaiyukan')).toBe(false);
    expect(out.candidates.some((p) => p.id === 'osaka-castle')).toBe(true);
    expect(out.goal).toContain('kaiyukan');
  });

  it('overbudget: measures the shortfall across the whole trip, not the day', () => {
    const out = ruleLayer(ctx({ type: 'overbudget', day: 2, payload: null }));
    const total = ALL_BLOCKS.reduce((s, b) => s + b.costPerPerson, 0); // 565
    expect(out.shortfall).toBe(Math.max(0, total - CONSTRAINTS.budgetCeiling));
    expect(out.maxOps).toBe(MAX_OVERBUDGET_OPS);
    expect(out.window.day).toBeNull(); // any day still ahead
  });

  it('overbudget: honours an explicit target', () => {
    const out = ruleLayer(ctx({ type: 'overbudget', day: 2, payload: { target: 300 } }));
    expect(out.shortfall).toBe(565 - 300);
    expect(out.goal).toContain('265 has to come off');
  });
});

// ---------------------------------------------------------------------------
// §8 step 7 — the hard check
// ---------------------------------------------------------------------------

describe('checkOps', () => {
  const base = {
    movableIds: new Set(['free-a', 'free-b']),
    immovableIds: new Set(['locked', 'past']),
    knownIds: new Set(ALL_BLOCKS.map((b) => b.id)),
    candidateIds: new Set(['nmao', 'osaka-science-museum']),
    window: { day: 2, earliestStart: '17:00', latestEnd: '23:59' },
    now: NOW,
  };

  it('voids the whole batch when an op touches a locked block', () => {
    const result = checkOps(
      [
        { op: 'move', blockId: 'locked', to: { day: 2, startTime: '18:00' }, note: 'n' },
        { op: 'keep', blockId: 'free-a', note: 'n' },
      ],
      base,
    );
    expect(result.fatal).toContain('locked');
    expect(result.kept).toEqual([]);
  });

  it('voids the whole batch when an op touches a block that has already happened', () => {
    const result = checkOps(
      [
        { op: 'remove', blockId: 'past', note: 'n' },
        { op: 'keep', blockId: 'free-a', note: 'n' },
      ],
      base,
    );
    expect(result.fatal).toContain('past');
    expect(result.kept).toEqual([]);
  });

  it('voids the whole batch when an add invents a place', () => {
    const result = checkOps(
      [
        {
          op: 'add',
          block: {
            day: 2,
            startTime: '18:00',
            durationMin: 60,
            title: 'Made up',
            placeId: 'no-such-place',
            costPerPerson: 0,
          },
          note: 'n',
        },
      ],
      base,
    );
    expect(result.fatal).toContain('no-such-place');
    expect(result.kept).toEqual([]);
  });

  it('discards only the offending op when a move lands outside the window', () => {
    const result = checkOps(
      [
        { op: 'move', blockId: 'free-a', to: { day: 2, startTime: '15:30' }, note: 'too early' },
        { op: 'keep', blockId: 'free-b', note: 'fine' },
      ],
      base,
    );
    expect(result.fatal).toBeNull();
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.op).toBe('keep');
    expect(codes(result.violations)).toEqual(['move_out_of_window']);
  });

  it('discards every op on a block that two ops disagree about', () => {
    const result = checkOps(
      [
        { op: 'move', blockId: 'free-a', to: { day: 2, startTime: '18:00' }, note: 'move it' },
        { op: 'remove', blockId: 'free-a', note: 'or remove it?' },
        { op: 'keep', blockId: 'free-b', note: 'fine' },
      ],
      base,
    );
    expect(result.fatal).toBeNull();
    // Neither of the conflicting ops survives — picking one would be a guess
    expect(result.kept.map((o) => (o.op === 'add' ? null : o.blockId))).toEqual(['free-b']);
    expect(codes(result.violations)).toEqual(['conflicting_ops']);
  });

  it('discards an op naming a block that is not in the trip', () => {
    const result = checkOps([{ op: 'remove', blockId: 'ghost', note: 'n' }], base);
    expect(result.fatal).toBeNull();
    expect(result.kept).toEqual([]);
    expect(codes(result.violations)).toEqual(['unknown_block']);
  });

  it('accepts a clean batch untouched', () => {
    const clean: ReplanOp[] = [
      { op: 'move', blockId: 'free-a', to: { day: 2, startTime: '17:30' }, note: 'after the delay' },
      { op: 'keep', blockId: 'free-b', note: 'still fine' },
    ];
    const result = checkOps(clean, base);
    expect(result.fatal).toBeNull();
    expect(result.kept).toEqual(clean);
    expect(result.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// replan — the batch-void rule end to end
// ---------------------------------------------------------------------------

describe('replan — touching a locked block', () => {
  const badOps = ops(
    { op: 'move', blockId: 'locked', to: { day: 2, startTime: '18:00' }, note: 'shift the aquarium' },
    { op: 'keep', blockId: 'free-a', note: 'fine' },
  );
  const goodOps = ops(
    { op: 'move', blockId: 'free-a', to: { day: 2, startTime: '17:30' }, note: 'after the delay' },
    { op: 'keep', blockId: 'free-b', note: 'still fits' },
  );

  it('throws the whole batch away and retries — not just the one op', async () => {
    const llm = new MockLLMClient({ responses: [badOps, goodOps] });
    const result = await replan(input(), deps({ llm }));

    expect(llm.callCount).toBe(2);
    expect(result.source).toBe('llm-retry');
    expect(result.attempts[0]?.error).toContain('locked');
    // The good op that shared the bad batch is gone too
    expect(opIds(result.ops)).toEqual(['free-a', 'free-b']);
  });

  it('returns empty ops and violations when the retry touches locked as well', async () => {
    const llm = new MockLLMClient({ responses: [badOps, badOps] });
    const result = await replan(input(), deps({ llm }));

    expect(llm.callCount).toBe(2);
    expect(result.source).toBe('failed');
    expect(result.ops).toEqual([]);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.budgetDelta).toBe(0);
  });

  it('does not throw on that path', async () => {
    const llm = new MockLLMClient({ responses: [badOps, badOps] });
    await expect(replan(input(), deps({ llm }))).resolves.toBeDefined();
  });

  it('treats an op on an already-past block the same way', async () => {
    const touchesPast = ops({ op: 'remove', blockId: 'past', note: 'undo the morning' });
    const llm = new MockLLMClient({ responses: [touchesPast, touchesPast] });
    const result = await replan(input(), deps({ llm }));

    expect(result.source).toBe('failed');
    expect(result.ops).toEqual([]);
    expect(result.attempts[0]?.error).toContain('past');
  });

  it('never lists an immovable block as changeable', async () => {
    const llm = new MockLLMClient({ responses: [goodOps] });
    const result = await replan(input(), deps({ llm }));

    expect(result.immovable.sort()).toEqual(['locked', 'past']);
    expect(result.movable).toEqual(['free-a', 'free-b']);
    const prompt = llm.prompts[0] ?? '';
    expect(prompt).toContain('CANNOT CHANGE');
    const changeable = prompt.slice(prompt.indexOf('YOU MAY CHANGE THESE'));
    expect(changeable).not.toContain('locked |');
  });
});

describe('replan — a missing note', () => {
  it('fails validation, because the schema requires one', async () => {
    const noNote = { ops: [{ op: 'remove', blockId: 'free-a' }] };
    const withNote = ops({ op: 'remove', blockId: 'free-a', note: 'no longer fits the day' });
    const llm = new MockLLMClient({ responses: [noNote, withNote] });
    const result = await replan(input(), deps({ llm }));

    expect(llm.callCount).toBe(2);
    expect(result.attempts[0]?.error).toContain('schema');
    expect(result.source).toBe('llm-retry');
  });

  it('rejects an empty note too', async () => {
    const blank = { ops: [{ op: 'remove', blockId: 'free-a', note: '' }] };
    const llm = new MockLLMClient({ responses: [blank, blank] });
    const result = await replan(input(), deps({ llm }));

    expect(result.source).toBe('failed');
    expect(result.ops).toEqual([]);
    expect(result.attempts[0]?.error).toContain('note');
  });
});

describe('replan — an empty op list', () => {
  it('is treated as the model not doing the work, for delay', async () => {
    const empty = { ops: [] };
    const good = ops({ op: 'remove', blockId: 'free-b', note: 'will not fit after the delay' });
    // An empty array fails the schema's min(1) as well; either way it costs the attempt
    const llm = new MockLLMClient({ responses: [empty, good] });
    const result = await replan(input(), deps({ llm }));

    expect(llm.callCount).toBe(2);
    expect(result.source).toBe('llm-retry');
    expect(result.ops).toHaveLength(1);
  });

  it('retries when every op was discarded and the disruption still needs answering', async () => {
    // Both ops target the same block, so both are discarded and nothing is left
    const conflicting = ops(
      { op: 'move', blockId: 'free-a', to: { day: 2, startTime: '18:00' }, note: 'move' },
      { op: 'remove', blockId: 'free-a', note: 'remove' },
    );
    const good = ops({ op: 'remove', blockId: 'free-a', note: 'does not fit' });
    const llm = new MockLLMClient({ responses: [conflicting, good] });
    const result = await replan(input(), deps({ llm }));

    expect(llm.callCount).toBe(2);
    expect(result.attempts[0]?.error).toContain('no usable ops');
    expect(result.source).toBe('llm-retry');
  });
});

// ---------------------------------------------------------------------------
// The four disruption types, through the whole pipeline
// ---------------------------------------------------------------------------

describe('replan — delay', () => {
  it('tells the model the day cannot start before the shifted time', async () => {
    const llm = new MockLLMClient({
      responses: [ops({ op: 'move', blockId: 'free-a', to: { day: 2, startTime: '17:30' }, note: 'n' })],
    });
    const result = await replan(input(), deps({ llm }));

    expect(result.window).toEqual({ day: 2, earliestStart: '17:00', latestEnd: '23:59' });
    expect(llm.prompts[0]).toContain('17:00');
    expect(result.source).toBe('llm');
  });

  it('discards a move that ignores the shift, keeping the rest', async () => {
    const llm = new MockLLMClient({
      responses: [
        ops(
          { op: 'move', blockId: 'free-a', to: { day: 2, startTime: '15:30' }, note: 'ignores the delay' },
          { op: 'remove', blockId: 'free-b', note: 'will not fit' },
        ),
      ],
    });
    const result = await replan(input(), deps({ llm }));

    expect(result.source).toBe('llm');
    expect(opIds(result.ops)).toEqual(['free-b']);
    expect(codes(result.violations)).toContain('move_out_of_window');
  });
});

describe('replan — weather', () => {
  it('offers only indoor replacements', async () => {
    const llm = new MockLLMClient({
      responses: [ops({ op: 'keep', blockId: 'free-a', note: 'already indoors' })],
    });
    await replan(
      input({ disruption: { type: 'weather', day: 2, payload: { condition: 'typhoon' } } }),
      deps({ llm }),
    );

    const prompt = llm.prompts[0] ?? '';
    const candidateSection = prompt.slice(prompt.indexOf('CANDIDATE PLACES'));
    const outdoor = SEED_PLACES.filter((p) => !p.indoor).map((p) => p.id);
    const indoor = SEED_PLACES.filter((p) => p.indoor).map((p) => p.id);

    expect(outdoor.length).toBeGreaterThan(0);
    for (const id of outdoor) expect(candidateSection).not.toContain(`- ${id} |`);
    expect(indoor.some((id) => candidateSection.includes(`- ${id} |`))).toBe(true);
  });

  it('says why, in the goal it hands the model', async () => {
    const llm = new MockLLMClient({
      responses: [ops({ op: 'keep', blockId: 'free-a', note: 'n' })],
    });
    await replan(
      input({ disruption: { type: 'weather', day: 2, payload: { condition: 'heavy rain' } } }),
      deps({ llm }),
    );
    expect(llm.prompts[0]).toContain('heavy rain');
    expect(llm.prompts[0]).toContain('must be indoors');
  });
});

describe('replan — closed', () => {
  it('keeps the shut place out of the candidate list', async () => {
    const llm = new MockLLMClient({
      responses: [ops({ op: 'remove', blockId: 'free-b', note: 'the place is shut' })],
    });
    const result = await replan(
      input({ disruption: { type: 'closed', day: 2, payload: { placeId: 'osaka-castle' } } }),
      deps({ llm }),
    );

    const candidateSection = (llm.prompts[0] ?? '').slice((llm.prompts[0] ?? '').indexOf('CANDIDATE PLACES'));
    expect(candidateSection).not.toContain('- osaka-castle |');
    expect(result.source).toBe('llm');
  });

  it('voids the batch if the model adds the very place that is shut', async () => {
    const readdShut = ops({
      op: 'add',
      block: {
        day: 2,
        startTime: '18:00',
        durationMin: 60,
        title: 'Back to the castle',
        placeId: 'osaka-castle',
        costPerPerson: 25,
      },
      note: 'ignoring the closure',
    });
    const llm = new MockLLMClient({ responses: [readdShut, readdShut] });
    const result = await replan(
      input({ disruption: { type: 'closed', day: 2, payload: { placeId: 'osaka-castle' } } }),
      deps({ llm }),
    );

    expect(result.source).toBe('failed');
    expect(result.ops).toEqual([]);
  });
});

describe('replan — overbudget', () => {
  /** Ceiling 1000; day 2's movable blocks are worth 115, days 3-4 hold the rest. */
  const EXPENSIVE: Block[] = [
    ...ALL_BLOCKS,
    block({ id: 'd5-a', day: 5, startTime: '10:00', placeId: 'kaiyukan', costPerPerson: 500 }),
    block({ id: 'd5-b', day: 5, startTime: '14:00', placeId: 'harukas-x', costPerPerson: 400 }),
  ];

  const OVERBUDGET: Disruption = { type: 'overbudget', day: 2, payload: null };

  it('reaches across days when one day cannot cover the shortfall', async () => {
    const total = EXPENSIVE.reduce((s, b) => s + b.costPerPerson, 0); // 1465
    const shortfall = total - CONSTRAINTS.budgetCeiling; // 465

    const llm = new MockLLMClient({
      responses: [
        ops(
          { op: 'remove', blockId: 'd5-a', note: 'the single most expensive stop' },
          { op: 'remove', blockId: 'd3-a', note: 'the next most expensive' },
        ),
      ],
    });
    const result = await replan(
      input({ blocks: EXPENSIVE, disruption: OVERBUDGET }),
      deps({ llm }),
    );

    expect(shortfall).toBeGreaterThan(150); // day 2 alone could never cover it
    expect(result.source).toBe('llm');
    // ops span days 3 and 5, not just the disruption's day 2
    expect(new Set(result.ops.map((o) => (o.op.op === 'remove' ? o.op.blockId : ''))).size).toBe(2);
    expect(-result.budgetDelta).toBeGreaterThanOrEqual(shortfall);
    expect(codes(result.violations)).not.toContain('still_over_budget');
  });

  it('presents the changeable blocks most expensive first', async () => {
    const llm = new MockLLMClient({ responses: [ops({ op: 'remove', blockId: 'd5-a', note: 'n' })] });
    const result = await replan(input({ blocks: EXPENSIVE, disruption: OVERBUDGET }), deps({ llm }));
    expect(result.movable.slice(0, 3)).toEqual(['d5-a', 'd5-b', 'd3-a']);
  });

  it('caps the diff at six ops so the screen stays readable', async () => {
    const many = ops(
      ...(['d5-a', 'd5-b', 'd3-a', 'd3-b', 'd4-a', 'free-a', 'free-b'] as const).map(
        (id): ReplanOp => ({ op: 'remove', blockId: id, note: `drop ${id}` }),
      ),
    );
    const llm = new MockLLMClient({ responses: [many] });
    const result = await replan(input({ blocks: EXPENSIVE, disruption: OVERBUDGET }), deps({ llm }));

    expect(result.ops.length).toBeLessThanOrEqual(MAX_OVERBUDGET_OPS);
    expect(result.ops).toHaveLength(6);
  });

  it('reports the remaining gap rather than touching a locked block to close it', async () => {
    // Only small cuts offered, nowhere near the shortfall
    const llm = new MockLLMClient({
      responses: [ops({ op: 'remove', blockId: 'free-a', note: 'the only thing offered' })],
    });
    const result = await replan(input({ blocks: EXPENSIVE, disruption: OVERBUDGET }), deps({ llm }));

    const stillOver = result.violations.find((v) => v.code === 'still_over_budget');
    expect(stillOver).toBeDefined();
    expect(stillOver?.detail?.['remaining']).toBe(465 - 55);
    // the locked block is worth 75 and was never proposed
    expect(opIds(result.ops)).not.toContain('locked');
  });

  it('leaves every locked and already-past block alone', async () => {
    const llm = new MockLLMClient({
      responses: [ops({ op: 'remove', blockId: 'd5-a', note: 'the priciest' })],
    });
    const result = await replan(input({ blocks: EXPENSIVE, disruption: OVERBUDGET }), deps({ llm }));

    expect(result.movable).not.toContain('locked');
    expect(result.movable).not.toContain('past');
    expect(result.movable).not.toContain('d1-a'); // day 1 is behind us
    expect(result.immovable).toEqual(['past', 'locked']);
  });
});

// ---------------------------------------------------------------------------
// Costing, and partial acceptance
// ---------------------------------------------------------------------------

describe('costDeltaOf', () => {
  const byId = new Map(ALL_BLOCKS.map((b) => [b.id, b]));

  it('prices each op kind', () => {
    expect(costDeltaOf({ op: 'keep', blockId: 'free-a', note: 'n' }, byId)).toBe(0);
    expect(
      costDeltaOf({ op: 'move', blockId: 'free-a', to: { day: 2, startTime: '18:00' }, note: 'n' }, byId),
    ).toBe(0);
    expect(costDeltaOf({ op: 'remove', blockId: 'free-a', note: 'n' }, byId)).toBe(-55);
    expect(
      costDeltaOf(
        {
          op: 'add',
          block: {
            day: 2,
            startTime: '18:00',
            durationMin: 60,
            title: 'x',
            placeId: 'nmao',
            costPerPerson: 30,
          },
          note: 'n',
        },
        byId,
      ),
    ).toBe(30);
  });

  it('puts a costDelta on every op in the diff', async () => {
    const llm = new MockLLMClient({
      responses: [
        ops(
          { op: 'remove', blockId: 'free-a', note: 'drop it' },
          { op: 'keep', blockId: 'free-b', note: 'keep it' },
        ),
      ],
    });
    const result = await replan(input(), deps({ llm }));

    expect(result.ops.map((o) => o.costDelta)).toEqual([-55, 0]);
    expect(result.ops.every((o) => typeof o.id === 'string' && o.id.length > 0)).toBe(true);
    expect(result.budgetDelta).toBe(-55);
  });
});

describe('applyDiff', () => {
  async function diffOf(...list: ReplanOp[]) {
    const llm = new MockLLMClient({ responses: [{ ops: list }] });
    return replan(input(), deps({ llm }));
  }

  it('counts only the ops that were actually accepted', async () => {
    const diff = await diffOf(
      { op: 'remove', blockId: 'free-a', note: 'drop the tower' }, // -55
      { op: 'remove', blockId: 'free-b', note: 'drop dinner' }, // -60
    );
    expect(diff.budgetDelta).toBe(-115);

    // The user ticks only the first box
    const accepted = diff.ops.filter((o) => o.op.op === 'remove' && o.op.blockId === 'free-a');
    const applied = applyDiff(ALL_BLOCKS, accepted);

    expect(applied.budgetDelta).toBe(-55);
    expect(applied.blocks.map((b) => b.id)).not.toContain('free-a');
    expect(applied.blocks.map((b) => b.id)).toContain('free-b');
  });

  it('accepting nothing changes nothing', () => {
    const applied = applyDiff(ALL_BLOCKS, []);
    expect(applied.budgetDelta).toBe(0);
    expect(applied.blocks.map((b) => b.id).sort()).toEqual(ALL_BLOCKS.map((b) => b.id).sort());
  });

  it('applies a move by rewriting the time, not the cost', async () => {
    const diff = await diffOf({
      op: 'move',
      blockId: 'free-a',
      to: { day: 2, startTime: '19:00', durationMin: 30 },
      note: 'after the delay',
    });
    const applied = applyDiff(ALL_BLOCKS, diff.ops);
    const moved = applied.blocks.find((b) => b.id === 'free-a');

    expect(moved?.startTime).toBe('19:00');
    expect(moved?.durationMin).toBe(30);
    expect(moved?.costPerPerson).toBe(55);
    expect(applied.budgetDelta).toBe(0);
  });

  it('marks an added block as coming from a re-plan', () => {
    const add: DiffOp = {
      id: 'op-01',
      costDelta: 30,
      violations: [],
      op: {
        op: 'add',
        block: {
          day: 2,
          startTime: '19:00',
          durationMin: 90,
          title: 'Museum instead',
          placeId: 'nmao',
          costPerPerson: 30,
        },
        note: 'indoor stand-in',
      },
    };
    const applied = applyDiff(ALL_BLOCKS, [add]);
    const added = applied.blocks.find((b) => b.title === 'Museum instead');

    expect(added?.createdBy).toBe('replan');
    expect(added?.locked).toBe(false);
    expect(applied.budgetDelta).toBe(30);
  });

  it('refuses an op against a locked block even when the client asks for it', () => {
    // A hand-rolled accepted list — exactly what a tampered request would look like
    const forged: DiffOp = {
      id: 'forged',
      costDelta: -75,
      violations: [],
      op: { op: 'remove', blockId: 'locked', note: 'please' },
    };
    const applied = applyDiff(ALL_BLOCKS, [forged]);

    expect(applied.blocks.map((b) => b.id)).toContain('locked');
    expect(applied.budgetDelta).toBe(0);
    expect(codes(applied.violations)).toEqual(['immovable_block']);
  });

  it('refuses an op against a block that has already happened', () => {
    const forged: DiffOp = {
      id: 'forged',
      costDelta: -25,
      violations: [],
      op: { op: 'remove', blockId: 'past', note: 'please' },
    };
    const immovableIds = new Set(
      ALL_BLOCKS.filter((b) => b.locked || hasPassed(b, NOW)).map((b) => b.id),
    );
    const applied = applyDiff(ALL_BLOCKS, [forged], { immovableIds });

    expect(applied.blocks.map((b) => b.id)).toContain('past');
    expect(applied.budgetDelta).toBe(0);
    expect(applied.violations).toHaveLength(1);
  });

  it('measures the delta from the blocks, not from what the ops claimed', () => {
    const lying: DiffOp = {
      id: 'op-01',
      costDelta: -9999, // nonsense
      violations: [],
      op: { op: 'remove', blockId: 'free-a', note: 'n' },
    };
    expect(applyDiff(ALL_BLOCKS, [lying]).budgetDelta).toBe(-55);
  });

  it('leaves the blocks it was given untouched', () => {
    const before = JSON.stringify(ALL_BLOCKS);
    applyDiff(ALL_BLOCKS, [
      {
        id: 'op-01',
        costDelta: 0,
        violations: [],
        op: { op: 'move', blockId: 'free-a', to: { day: 3, startTime: '09:00' }, note: 'n' },
      },
    ]);
    expect(JSON.stringify(ALL_BLOCKS)).toBe(before);
  });

  it('returns the itinerary in reading order', () => {
    const applied = applyDiff(ALL_BLOCKS, []);
    const order = applied.blocks.map((b) => `${b.day}${b.startTime}`);
    expect([...order].sort()).toEqual(order);
  });
});

// ---------------------------------------------------------------------------
// It only ever computes
// ---------------------------------------------------------------------------

describe('replan — no side effects', () => {
  it('returns a pending diff and does not touch the blocks it was given', async () => {
    const before = JSON.stringify(ALL_BLOCKS);
    const llm = new MockLLMClient({
      responses: [ops({ op: 'remove', blockId: 'free-a', note: 'n' })],
    });
    const result = await replan(input(), deps({ llm }));

    expect(result.status).toBe('pending');
    expect(JSON.stringify(ALL_BLOCKS)).toBe(before);
  });

  it('survives a places repository that throws', async () => {
    const throwing = {
      byCity: async () => {
        throw new Error('supabase down');
      },
    };
    const result = await replan(input(), deps({ places: throwing }));
    expect(result.source).toBe('failed');
    expect(result.ops).toEqual([]);
  });

  it('carries the retrieved knowledge out for the notes', async () => {
    const llm = new MockLLMClient({
      responses: [ops({ op: 'keep', blockId: 'free-a', note: 'n' })],
    });
    const result = await replan(input(), deps({ llm }));
    expect(result.citations.length).toBeGreaterThan(0);
    expect(llm.prompts[0]).toContain('LOCAL KNOWLEDGE');
  });
});
