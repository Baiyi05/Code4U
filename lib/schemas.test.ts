import { describe, expect, it } from 'vitest';

import { buildConstraints } from './constraints';
import {
  BlockSchema,
  ConstraintsSchema,
  ItineraryDraftSchema,
  MemberSchema,
  OpeningHoursSchema,
  PlaceSchema,
  PreferenceSchema,
  ReplanOpsSchema,
  TripSchema,
  ValidationResultSchema,
  type Trip,
} from './schemas';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TRIP: Trip = {
  id: 'trip-1',
  slug: 'OSK-4K2',
  destination: 'Osaka',
  cityKey: 'osaka',
  startDate: '2026-09-07',
  endDate: '2026-09-09',
  budgetPerPerson: 1200,
};

const DRAFT_BLOCK = {
  day: 1,
  startTime: '10:00',
  durationMin: 90,
  title: 'Osaka Castle',
  placeId: 'ChIJ-osaka-castle',
  costPerPerson: 600,
};

// ---------------------------------------------------------------------------
// domain types
// ---------------------------------------------------------------------------

describe('domain schemas', () => {
  it('accepts a trip and rejects a non-ISO date', () => {
    expect(TripSchema.parse(TRIP).cityKey).toBe('osaka');
    expect(TripSchema.safeParse({ ...TRIP, startDate: '07/09/2026' }).success).toBe(false);
  });

  it('accepts a member', () => {
    expect(
      MemberSchema.parse({ id: 'm1', tripId: 'trip-1', displayName: 'Ada', isCaptain: true }),
    ).toMatchObject({ displayName: 'Ada' });
  });

  it('accepts a preference with every optional field null', () => {
    const parsed = PreferenceSchema.parse({
      memberId: 'm1',
      tripId: 'trip-1',
      budgetBand: null,
      pace: null,
      interests: null,
      dietary: null,
      mustDo: null,
      noGo: null,
    });
    expect(parsed.budgetBand).toBeNull();
  });

  it('rejects a pace or band outside the allowed set', () => {
    const base = {
      memberId: 'm1',
      tripId: 'trip-1',
      budgetBand: null,
      pace: null,
      interests: null,
      dietary: null,
      mustDo: null,
      noGo: null,
    };
    expect(PreferenceSchema.safeParse({ ...base, pace: 'frantic' }).success).toBe(false);
    expect(PreferenceSchema.safeParse({ ...base, budgetBand: 'medium' }).success).toBe(false);
  });

  it('accepts a place, including opening hours', () => {
    const place = PlaceSchema.parse({
      id: 'p1',
      cityKey: 'osaka',
      name: 'Osaka Castle',
      category: 'sight',
      district: 'chuo',
      lat: null,
      lng: null,
      openingHours: { periods: { 1: [{ open: '09:00', close: '17:00' }] } },
      estCostPerPerson: 600,
      avgDurationMin: 90,
      indoor: false,
      vegFriendly: false,
    });
    expect(place.openingHours?.periods?.['1']).toHaveLength(1);
  });

  it('accepts a block with the seconds Postgres time columns come back with', () => {
    expect(
      BlockSchema.parse({
        id: 'b1',
        day: 1,
        startTime: '10:00:00',
        durationMin: 90,
        title: 'Osaka Castle',
        placeId: 'p1',
        costPerPerson: 600,
        locked: false,
      }).startTime,
    ).toBe('10:00:00');
  });

  it('drops unknown keys rather than failing — an extra field must not cost a retry', () => {
    const parsed = TripSchema.parse({ ...TRIP, weather: 'sunny' });
    expect(parsed).not.toHaveProperty('weather');
  });
});

describe('OpeningHoursSchema', () => {
  it('accepts alwaysOpen on its own', () => {
    expect(OpeningHoursSchema.parse({ alwaysOpen: true }).alwaysOpen).toBe(true);
  });

  it('accepts a dated exception', () => {
    const oh = OpeningHoursSchema.parse({ exceptions: { '2026-09-08': [] } });
    expect(oh.exceptions?.['2026-09-08']).toEqual([]);
  });

  it('rejects a weekday key outside 0–6', () => {
    expect(OpeningHoursSchema.safeParse({ periods: { 9: [] } }).success).toBe(false);
  });

  it('rejects an exception key that is not a date', () => {
    expect(OpeningHoursSchema.safeParse({ exceptions: { monday: [] } }).success).toBe(false);
  });

  it("keeps a past-midnight close time — '25:30' has to survive", () => {
    const oh = OpeningHoursSchema.parse({ periods: { 5: [{ open: '18:00', close: '25:30' }] } });
    expect(oh.periods?.['5']?.[0]?.close).toBe('25:30');
  });
});

// ---------------------------------------------------------------------------
// rule-engine output
// ---------------------------------------------------------------------------

describe('ConstraintsSchema', () => {
  it('accepts what buildConstraints actually returns', () => {
    expect(ConstraintsSchema.safeParse(buildConstraints(TRIP, [])).success).toBe(true);
  });

  it('accepts the degraded startDate the engine falls back to', () => {
    // An unreadable string is passed through as-is...
    const unreadable = buildConstraints({ ...TRIP, startDate: 'not a date' }, []);
    expect(unreadable.startDate).toBe('not a date');
    expect(ConstraintsSchema.safeParse(unreadable).success).toBe(true);

    // ...and anything that is not a string at all becomes ''
    const missing = buildConstraints({ ...TRIP, startDate: null as unknown as string }, []);
    expect(missing.startDate).toBe('');
    expect(ConstraintsSchema.safeParse(missing).success).toBe(true);

    // Which is why ConstraintsSchema.startDate is a plain string, not IsoDateSchema:
    // buildConstraints degrades instead of throwing, so the schema has to accept
    // everything it can produce.
    expect(TripSchema.safeParse({ ...TRIP, startDate: 'not a date' }).success).toBe(false);
  });
});

describe('ValidationResultSchema', () => {
  it('accepts a violation carrying a free-form detail bag', () => {
    const parsed = ValidationResultSchema.parse({
      ok: false,
      violations: [
        { code: 'over_budget', message: 'over', detail: { total: 400, ceiling: 300 } },
        { code: 'unknown_place', message: 'nope', blockId: 'b1', day: 2 },
      ],
    });
    expect(parsed.violations).toHaveLength(2);
  });

  it('rejects a code that is not one of the nine', () => {
    expect(
      ValidationResultSchema.safeParse({ ok: false, violations: [{ code: 'oops', message: 'x' }] })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LLM output — itinerary draft (§7 step 5)
// ---------------------------------------------------------------------------

describe('ItineraryDraftSchema', () => {
  it('accepts a minimal draft', () => {
    const draft = ItineraryDraftSchema.parse({ blocks: [DRAFT_BLOCK] });
    expect(draft.blocks[0]?.title).toBe('Osaka Castle');
  });

  it('accepts reason and sourceCitation alongside the block', () => {
    const draft = ItineraryDraftSchema.parse({
      blocks: [
        {
          ...DRAFT_BLOCK,
          reason: { budget: 'fits the 800 ceiling', votes: '3 of 4 wanted history' },
          sourceCitation: { text: 'best at opening', source: 'osaka-guide', url: 'https://x.test' },
        },
      ],
      summary: 'Day one runs on the castle.',
    });
    expect(draft.blocks[0]?.sourceCitation?.source).toBe('osaka-guide');
  });

  it('rejects a block with no placeId — the schema half of the anti-hallucination rule', () => {
    expect(ItineraryDraftSchema.safeParse({ blocks: [{ ...DRAFT_BLOCK, placeId: '' }] }).success).toBe(
      false,
    );
    const { placeId: _dropped, ...withoutPlace } = DRAFT_BLOCK;
    expect(ItineraryDraftSchema.safeParse({ blocks: [withoutPlace] }).success).toBe(false);
  });

  it('rejects an empty itinerary', () => {
    expect(ItineraryDraftSchema.safeParse({ blocks: [] }).success).toBe(false);
  });

  it('rejects a start time that is not a wall clock', () => {
    for (const startTime of ['25:30', '10:00:00', '9:00', 'morning']) {
      expect(ItineraryDraftSchema.safeParse({ blocks: [{ ...DRAFT_BLOCK, startTime }] }).success).toBe(
        false,
      );
    }
  });

  it('rejects a negative cost or duration, and a day below 1', () => {
    expect(
      ItineraryDraftSchema.safeParse({ blocks: [{ ...DRAFT_BLOCK, costPerPerson: -1 }] }).success,
    ).toBe(false);
    expect(
      ItineraryDraftSchema.safeParse({ blocks: [{ ...DRAFT_BLOCK, durationMin: -30 }] }).success,
    ).toBe(false);
    expect(ItineraryDraftSchema.safeParse({ blocks: [{ ...DRAFT_BLOCK, day: 0 }] }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// LLM output — re-plan ops (§8 step 6)
// ---------------------------------------------------------------------------

describe('ReplanOpsSchema', () => {
  it('accepts all four op kinds together', () => {
    const parsed = ReplanOpsSchema.parse({
      ops: [
        { op: 'keep', blockId: 'b1', note: 'locked, untouched' },
        { op: 'move', blockId: 'b2', to: { day: 1, startTime: '14:00' }, note: 'train is late' },
        { op: 'remove', blockId: 'b3', note: 'closed today' },
        { op: 'add', block: DRAFT_BLOCK, note: 'indoor stand-in for the rain' },
      ],
      budgetDelta: -200,
    });
    expect(parsed.ops.map((o) => o.op)).toEqual(['keep', 'move', 'remove', 'add']);
  });

  it('rejects an op with no note — §8 step 7 wants a reason for every change', () => {
    expect(ReplanOpsSchema.safeParse({ ops: [{ op: 'remove', blockId: 'b1' }] }).success).toBe(false);
    expect(
      ReplanOpsSchema.safeParse({ ops: [{ op: 'remove', blockId: 'b1', note: '' }] }).success,
    ).toBe(false);
  });

  it('rejects a move with no destination', () => {
    expect(
      ReplanOpsSchema.safeParse({ ops: [{ op: 'move', blockId: 'b1', note: 'why' }] }).success,
    ).toBe(false);
  });

  it('rejects an op kind the model made up', () => {
    expect(
      ReplanOpsSchema.safeParse({ ops: [{ op: 'reschedule', blockId: 'b1', note: 'why' }] }).success,
    ).toBe(false);
  });

  it('rejects an added block that skips placeId, same as in a draft', () => {
    const { placeId: _dropped, ...withoutPlace } = DRAFT_BLOCK;
    expect(
      ReplanOpsSchema.safeParse({ ops: [{ op: 'add', block: withoutPlace, note: 'why' }] }).success,
    ).toBe(false);
  });

  it('rejects an empty op list', () => {
    expect(ReplanOpsSchema.safeParse({ ops: [] }).success).toBe(false);
  });

  it('narrows on the op discriminator', () => {
    const parsed = ReplanOpsSchema.parse({
      ops: [{ op: 'move', blockId: 'b2', to: { day: 2, startTime: '09:30', durationMin: 60 }, note: 'n' }],
    });
    const first = parsed.ops[0];
    // The discriminated union is what lets replan.ts read `.to` without a cast
    expect(first?.op === 'move' ? first.to.startTime : null).toBe('09:30');
  });
});
