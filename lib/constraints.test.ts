import { describe, expect, it } from 'vitest';

import {
  bandCeiling,
  BAND_RATIO,
  buildConstraints,
  enforceBudget,
  filterCandidates,
  totalCost,
  validateItinerary,
} from './constraints';
import type {
  Block,
  Constraints,
  Place,
  Preference,
  Trip,
  ViolationCode,
} from './schemas';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 2026-09-07 (Monday) – 09-09 (Wednesday), 3 days */
const TRIP: Trip = {
  id: 'trip-1',
  slug: 'OSK-4K2',
  destination: 'Osaka',
  cityKey: 'osaka',
  startDate: '2026-09-07',
  endDate: '2026-09-09',
  budgetPerPerson: 1200,
};

let memberSeq = 0;
function makePref(over: Partial<Preference> = {}): Preference {
  memberSeq += 1;
  return {
    memberId: `m${memberSeq}`,
    tripId: TRIP.id,
    budgetBand: null,
    pace: null,
    interests: null,
    dietary: null,
    mustDo: null,
    noGo: null,
    ...over,
  };
}

function makePlace(over: Partial<Place> = {}): Place {
  return {
    id: 'p1',
    cityKey: 'osaka',
    name: 'Osaka Castle',
    category: 'sight',
    district: 'chuo',
    lat: null,
    lng: null,
    openingHours: null,
    estCostPerPerson: 0,
    avgDurationMin: 60,
    indoor: false,
    vegFriendly: false,
    ...over,
  };
}

function makeBlock(over: Partial<Block> = {}): Block {
  return {
    id: 'b1',
    day: 1,
    startTime: '10:00',
    durationMin: 60,
    title: 'Osaka Castle',
    subtitle: null,
    placeId: 'p1',
    costPerPerson: 0,
    locked: false,
    ...over,
  };
}

/** Built from TRIP, overriding only the fields a test cares about */
function constraintsWith(over: Partial<Constraints> = {}): Constraints {
  return { ...buildConstraints(TRIP, []), ...over };
}

function codes(violations: { code: ViolationCode }[]): ViolationCode[] {
  return violations.map((v) => v.code);
}

function ids(blocks: readonly Block[]): string[] {
  return blocks.map((b) => b.id);
}

// ---------------------------------------------------------------------------
// 1. buildConstraints
// ---------------------------------------------------------------------------

describe('buildConstraints — budgetCeiling', () => {
  // TRIP.budgetPerPerson is 1200, so the three bands land on 1020 / 1140 / 1200
  const LOW = bandCeiling('low', TRIP.budgetPerPerson);
  const MID = bandCeiling('mid', TRIP.budgetPerPerson);
  const HIGH = bandCeiling('high', TRIP.budgetPerPerson);

  it('takes the lowest member ceiling, not the average', () => {
    const c = buildConstraints(TRIP, [
      makePref({ budgetBand: 'low' }),
      makePref({ budgetBand: 'mid' }),
      makePref({ budgetBand: 'high' }),
    ]);

    expect(c.budgetCeiling).toBe(LOW);

    // Pin down "not the average" explicitly — spec §7 calls this rule out by name
    const average = (LOW + MID + HIGH) / 3;
    expect(c.budgetCeiling).not.toBe(average);
    expect(c.budgetCeiling).toBeLessThan(average);
  });

  it('scales the bands off trip.budgetPerPerson rather than fixed amounts', () => {
    const cheap = { ...TRIP, budgetPerPerson: 800 };
    expect(buildConstraints(cheap, [makePref({ budgetBand: 'low' })]).budgetCeiling).toBe(
      Math.round(800 * BAND_RATIO.low),
    );
    expect(buildConstraints(cheap, [makePref({ budgetBand: 'mid' })]).budgetCeiling).toBe(
      Math.round(800 * BAND_RATIO.mid),
    );
    expect(buildConstraints(cheap, [makePref({ budgetBand: 'high' })]).budgetCeiling).toBe(800);

    // The same bands on a richer trip give bigger ceilings — nothing is hardcoded
    expect(buildConstraints(cheap, [makePref({ budgetBand: 'low' })]).budgetCeiling).toBeLessThan(
      buildConstraints(TRIP, [makePref({ budgetBand: 'low' })]).budgetCeiling,
    );
  });

  it('caps at trip.budgetPerPerson when everyone picks the top band — not infinity', () => {
    const c = buildConstraints(TRIP, [
      makePref({ budgetBand: 'high' }),
      makePref({ budgetBand: 'high' }),
      makePref({ budgetBand: 'high' }),
      makePref({ budgetBand: 'high' }),
    ]);
    expect(c.budgetCeiling).toBe(TRIP.budgetPerPerson);
    expect(Number.isFinite(c.budgetCeiling)).toBe(true);
  });

  it('lets one low member set the ceiling regardless of everyone else', () => {
    const withLow = buildConstraints(TRIP, [
      makePref({ budgetBand: 'high' }),
      makePref({ budgetBand: 'high' }),
      makePref({ budgetBand: 'low' }),
      makePref({ budgetBand: 'mid' }),
    ]);
    expect(withLow.budgetCeiling).toBe(Math.round(TRIP.budgetPerPerson * BAND_RATIO.low));
    // The other three bands moved the answer not at all
    expect(withLow.budgetCeiling).toBe(
      buildConstraints(TRIP, [makePref({ budgetBand: 'low' })]).budgetCeiling,
    );
  });

  it('does not depend on member order', () => {
    const low = makePref({ budgetBand: 'low' });
    const high = makePref({ budgetBand: 'high' });
    expect(buildConstraints(TRIP, [low, high]).budgetCeiling).toBe(
      buildConstraints(TRIP, [high, low]).budgetCeiling,
    );
  });

  it('counts a missing or invalid band as mid', () => {
    expect(buildConstraints(TRIP, [makePref({ budgetBand: null })]).budgetCeiling).toBe(MID);
    expect(
      buildConstraints(TRIP, [makePref({ budgetBand: 'luxury' as never })]).budgetCeiling,
    ).toBe(MID);
    // and it still takes part in the minimum
    expect(
      buildConstraints(TRIP, [makePref({ budgetBand: null }), makePref({ budgetBand: 'low' })])
        .budgetCeiling,
    ).toBe(LOW);
  });

  it('falls back to trip.budgetPerPerson when there are no preferences at all', () => {
    expect(buildConstraints(TRIP, []).budgetCeiling).toBe(TRIP.budgetPerPerson);
    expect(buildConstraints(TRIP).budgetCeiling).toBe(TRIP.budgetPerPerson);
  });

  it('lets the band ratios be overridden', () => {
    const c = buildConstraints(TRIP, [makePref({ budgetBand: 'low' })], {
      bandRatio: { low: 0.25, mid: 0.5, high: 1 },
    });
    expect(c.budgetCeiling).toBe(300);
  });
});

describe('buildConstraints — blocksPerDay', () => {
  it('follows the majority pace: chill 3 / balanced 4 / packed 5', () => {
    const chill = buildConstraints(TRIP, [
      makePref({ pace: 'chill' }),
      makePref({ pace: 'chill' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(chill.pace).toBe('chill');
    expect(chill.blocksPerDay).toBe(3);

    const balanced = buildConstraints(TRIP, [
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'chill' }),
    ]);
    expect(balanced.pace).toBe('balanced');
    expect(balanced.blocksPerDay).toBe(4);

    const packed = buildConstraints(TRIP, [
      makePref({ pace: 'packed' }),
      makePref({ pace: 'packed' }),
      makePref({ pace: 'chill' }),
    ]);
    expect(packed.pace).toBe('packed');
    expect(packed.blocksPerDay).toBe(5);
  });

  it('falls back to balanced on a tie: chill x1 vs packed x1', () => {
    const c = buildConstraints(TRIP, [makePref({ pace: 'chill' }), makePref({ pace: 'packed' })]);
    expect(c.pace).toBe('balanced');
    expect(c.blocksPerDay).toBe(4);
  });

  it('falls back to balanced on a tie: balanced x2 vs packed x2', () => {
    const c = buildConstraints(TRIP, [
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'packed' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(c.pace).toBe('balanced');
    expect(c.blocksPerDay).toBe(4);
  });

  it('falls back to balanced even when neither tied side is balanced: chill x2 vs packed x2', () => {
    const c = buildConstraints(TRIP, [
      makePref({ pace: 'chill' }),
      makePref({ pace: 'chill' }),
      makePref({ pace: 'packed' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(c.pace).toBe('balanced');
    expect(c.blocksPerDay).toBe(4);
  });

  it('falls back to balanced on a three-way tie', () => {
    const c = buildConstraints(TRIP, [
      makePref({ pace: 'chill' }),
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(c.pace).toBe('balanced');
  });

  it('uses balanced when nobody stated a pace', () => {
    expect(buildConstraints(TRIP, [makePref(), makePref()]).pace).toBe('balanced');
    expect(buildConstraints(TRIP, []).pace).toBe('balanced');
  });

  it('lets the tie-break fallback be overridden', () => {
    const c = buildConstraints(TRIP, [makePref({ pace: 'chill' }), makePref({ pace: 'packed' })], {
      defaultPace: 'chill',
    });
    expect(c.pace).toBe('chill');
    expect(c.blocksPerDay).toBe(3);
  });
});

describe('buildConstraints — tag unions', () => {
  it('requiredTags is the union of everyone dietary, deduped case-insensitively', () => {
    const c = buildConstraints(TRIP, [
      makePref({ dietary: ['halal', 'vegetarian'] }),
      makePref({ dietary: ['Halal', '  ', 'no pork'] }),
      makePref({ dietary: null }),
    ]);
    expect(c.requiredTags).toEqual(['halal', 'vegetarian', 'no pork']);
  });

  it('forced collects every mustDo, split on separators', () => {
    const c = buildConstraints(TRIP, [
      makePref({ mustDo: 'Universal Studios, Dotonbori' }),
      makePref({ mustDo: 'teamLab; Universal Studios' }),
      makePref({ mustDo: '   ' }),
    ]);
    expect(c.forced).toEqual(['Universal Studios', 'Dotonbori', 'teamLab']);
  });

  it('excluded is the union of everyone noGo', () => {
    const c = buildConstraints(TRIP, [
      makePref({ noGo: 'nightclub; casino' }),
      makePref({ noGo: 'nightclub\nseafood' }),
    ]);
    expect(c.excluded).toEqual(['nightclub', 'casino', 'seafood']);
  });

  it('splits full-width separators too (members may type in any locale)', () => {
    const c = buildConstraints(TRIP, [makePref({ noGo: 'casino，nightclub、seafood' })]);
    expect(c.excluded).toEqual(['casino', 'nightclub', 'seafood']);
  });

  it('lets the splitter be overridden', () => {
    const c = buildConstraints(TRIP, [makePref({ noGo: 'a|b' })], {
      splitFreeText: (v) => v.split('|'),
    });
    expect(c.excluded).toEqual(['a', 'b']);
  });

  it('returns empty arrays when nobody filled anything in', () => {
    const c = buildConstraints(TRIP, [makePref()]);
    expect(c.requiredTags).toEqual([]);
    expect(c.forced).toEqual([]);
    expect(c.excluded).toEqual([]);
  });
});

describe('buildConstraints — trip length and passthrough', () => {
  it('days = end - start + 1', () => {
    expect(buildConstraints(TRIP, []).days).toBe(3);
  });

  it('same-day trip is 1 day', () => {
    expect(
      buildConstraints({ ...TRIP, startDate: '2026-09-07', endDate: '2026-09-07' }, []).days,
    ).toBe(1);
  });

  it('spans month boundaries correctly', () => {
    expect(
      buildConstraints({ ...TRIP, startDate: '2026-08-30', endDate: '2026-09-02' }, []).days,
    ).toBe(4);
  });

  it('falls back to 1 day on invalid dates instead of throwing', () => {
    expect(buildConstraints({ ...TRIP, endDate: '2026-02-30' }, []).days).toBe(1);
    expect(buildConstraints({ ...TRIP, startDate: 'tomorrow' }, []).days).toBe(1);
  });

  it('passes cityKey and startDate straight through', () => {
    const c = buildConstraints(TRIP, []);
    expect(c.cityKey).toBe('osaka');
    expect(c.startDate).toBe('2026-09-07');
  });
});

// ---------------------------------------------------------------------------
// 2. filterCandidates
// ---------------------------------------------------------------------------

describe('filterCandidates', () => {
  it('drops places whose category matches excluded', () => {
    const c = constraintsWith({ excluded: ['nightclub'] });
    const places = [
      makePlace({ id: 'keep', category: 'sight' }),
      makePlace({ id: 'drop', category: 'nightclub' }),
    ];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['keep']);
  });

  it('matches excluded against the name as well', () => {
    const c = constraintsWith({ excluded: ['seafood'] });
    const places = [
      makePlace({ id: 'keep', name: 'Osaka Castle' }),
      makePlace({ id: 'drop', name: 'Kuromon Seafood Market' }),
    ];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['keep']);
  });

  it('ignores district by default, and honours it when asked', () => {
    const c = constraintsWith({ excluded: ['namba'] });
    const places = [makePlace({ id: 'x', district: 'namba' })];

    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['x']);
    expect(
      filterCandidates(places, c, 1, { matchExcludedAgainst: ['category', 'name', 'district'] }),
    ).toEqual([]);
  });

  it('ignores a single-ASCII-character noGo (a "b" must not drop every bar)', () => {
    const c = constraintsWith({ excluded: ['b'] });
    const places = [makePlace({ id: 'bar', category: 'bar' })];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['bar']);
  });

  it('still honours a single-glyph noGo from a non-ASCII script', () => {
    // Prefetched Osaka POIs carry Japanese names, and one glyph there is a whole word
    const c = constraintsWith({ excluded: ['酒'] });
    const places = [makePlace({ id: 'drop', category: '居酒屋' }), makePlace({ id: 'keep' })];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['keep']);
  });

  it('drops places from other cities', () => {
    const c = constraintsWith();
    const places = [makePlace({ id: 'osk' }), makePlace({ id: 'kul', cityKey: 'kualalumpur' })];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['osk']);
  });

  it('drops places closed that day: the weekday is absent from periods', () => {
    const c = constraintsWith();
    // Day 1 is 2026-09-07, a Monday (weekday 1); this place only lists Tuesday
    const closedOnMonday = makePlace({
      id: 'tue-only',
      openingHours: { periods: { 2: [{ open: '09:00', close: '18:00' }] } },
    });
    expect(filterCandidates([closedOnMonday], c, 1)).toEqual([]);
    expect(filterCandidates([closedOnMonday], c, 2).map((p) => p.id)).toEqual(['tue-only']);
  });

  it('drops places closed that day: the weekday maps to an empty array', () => {
    const c = constraintsWith();
    const place = makePlace({
      id: 'x',
      openingHours: { periods: { 1: [], 2: [{ open: '09:00', close: '18:00' }] } },
    });
    expect(filterCandidates([place], c, 1)).toEqual([]);
    expect(filterCandidates([place], c, 2).map((p) => p.id)).toEqual(['x']);
  });

  it('lets exceptions override periods (one-off closure)', () => {
    const c = constraintsWith();
    const place = makePlace({
      id: 'x',
      openingHours: {
        periods: { 1: [{ open: '09:00', close: '18:00' }] },
        exceptions: { '2026-09-07': [] },
      },
    });
    expect(filterCandidates([place], c, 1)).toEqual([]);
  });

  it('keeps places with missing openingHours (never wash the candidate pool out)', () => {
    const c = constraintsWith();
    const unknown = makePlace({ id: 'unknown', openingHours: null });
    const garbage = makePlace({
      id: 'garbage',
      openingHours: { periods: { 1: [{ open: '???', close: '???' }] } },
    });
    expect(filterCandidates([unknown, garbage], c, 1).map((p) => p.id)).toEqual([
      'unknown',
      'garbage',
    ]);
  });

  it('always keeps an alwaysOpen place', () => {
    const c = constraintsWith();
    const place = makePlace({ id: 'x', openingHours: { alwaysOpen: true, periods: { 2: [] } } });
    expect(filterCandidates([place], c, 1).map((p) => p.id)).toEqual(['x']);
  });

  it('preserves extra fields the caller carries on its own type', () => {
    const c = constraintsWith();
    const enriched = { ...makePlace(), similarity: 0.87 };
    const [first] = filterCandidates([enriched], c, 1);
    expect(first?.similarity).toBe(0.87);
  });

  it('returns an empty array instead of throwing when given a non-array', () => {
    const c = constraintsWith();
    expect(filterCandidates(null as unknown as Place[], c, 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. validateItinerary
// ---------------------------------------------------------------------------

describe('validateItinerary — placeId must come from the candidates', () => {
  it('reports nothing for a clean itinerary', () => {
    const c = constraintsWith({ budgetCeiling: 500 });
    const places = [makePlace({ id: 'p1' })];
    const blocks = [makeBlock({ placeId: 'p1', costPerPerson: 100 })];
    expect(validateItinerary(blocks, c, places)).toEqual({ ok: true, violations: [] });
  });

  it('flags a place the LLM invented', () => {
    const c = constraintsWith();
    const result = validateItinerary([makeBlock({ placeId: 'hallucinated' })], c, ['p1']);
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toEqual(['unknown_place']);
    expect(result.violations[0]?.detail).toMatchObject({ placeId: 'hallucinated' });
  });

  it('flags a block with no placeId', () => {
    const c = constraintsWith();
    const result = validateItinerary([makeBlock({ placeId: null })], c, ['p1']);
    expect(codes(result.violations)).toEqual(['missing_place']);
  });
});

describe('validateItinerary — budget', () => {
  it('passes when the total lands exactly on the ceiling', () => {
    const c = constraintsWith({ budgetCeiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', costPerPerson: 200 }),
      makeBlock({ id: 'b', startTime: '14:00', costPerPerson: 100 }),
    ];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('flags a total one unit over the ceiling', () => {
    const c = constraintsWith({ budgetCeiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', costPerPerson: 200 }),
      makeBlock({ id: 'b', startTime: '14:00', costPerPerson: 101 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['over_budget']);
    expect(result.violations[0]?.detail).toMatchObject({ total: 301, ceiling: 300, over: 1 });
  });

  it('sums across the whole trip, not per day', () => {
    const c = constraintsWith({ budgetCeiling: 150 });
    const blocks = [
      makeBlock({ id: 'a', day: 1, costPerPerson: 100 }),
      makeBlock({ id: 'b', day: 2, costPerPerson: 100 }),
    ];
    expect(codes(validateItinerary(blocks, c, ['p1']).violations)).toContain('over_budget');
  });
});

describe('validateItinerary — no overlaps within a day', () => {
  it('catches an overlap', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'a', startTime: '10:00', durationMin: 120 }),
      makeBlock({ id: 'b', startTime: '11:00', durationMin: 60 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['overlap']);
    expect(result.violations[0]).toMatchObject({ day: 1, detail: { withBlockId: 'b' } });
  });

  it('treats back-to-back blocks as fine', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'a', startTime: '10:00', durationMin: 60 }),
      makeBlock({ id: 'b', startTime: '11:00', durationMin: 60 }),
    ];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('does not treat the same slot on different days as an overlap', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'a', day: 1, startTime: '10:00' }),
      makeBlock({ id: 'b', day: 2, startTime: '10:00' }),
    ];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('reports both pairs when one long block swallows two short ones', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'big', startTime: '09:00', durationMin: 300 }),
      makeBlock({ id: 's1', startTime: '10:00', durationMin: 30 }),
      makeBlock({ id: 's2', startTime: '12:00', durationMin: 30 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['overlap', 'overlap']);
  });
});

describe('validateItinerary — opening hours', () => {
  const openMonday9to18 = makePlace({
    id: 'p1',
    name: 'Osaka Castle',
    openingHours: { periods: { 1: [{ open: '09:00', close: '18:00' }] } },
  });

  it('passes when the block sits entirely inside the opening hours', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ startTime: '10:00', durationMin: 120 })];
    expect(validateItinerary(blocks, c, [openMonday9to18]).ok).toBe(true);
  });

  it('flags a block that runs past closing time', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ startTime: '17:00', durationMin: 120 })];
    const result = validateItinerary(blocks, c, [openMonday9to18]);
    expect(codes(result.violations)).toEqual(['outside_opening_hours']);
    expect(result.violations[0]?.detail).toMatchObject({ block: '17:00-19:00' });
  });

  it('flags a block scheduled before opening time', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ startTime: '08:00', durationMin: 30 })];
    expect(codes(validateItinerary(blocks, c, [openMonday9to18]).violations)).toEqual([
      'outside_opening_hours',
    ]);
  });

  it('flags a place that is closed all day', () => {
    const c = constraintsWith();
    // Open Tuesdays only, while day 1 of the trip is a Monday
    const tuesdayOnly = makePlace({
      id: 'p1',
      openingHours: { periods: { 2: [{ open: '09:00', close: '18:00' }] } },
    });
    expect(codes(validateItinerary([makeBlock()], c, [tuesdayOnly]).violations)).toEqual([
      'closed_that_day',
    ]);
  });

  it('handles past-midnight hours: an 18:00–02:00 venue accepts a 23:00 block', () => {
    const c = constraintsWith();
    const bar = makePlace({
      id: 'p1',
      openingHours: { periods: { 1: [{ open: '18:00', close: '02:00' }] } },
    });
    expect(
      validateItinerary([makeBlock({ startTime: '23:00', durationMin: 90 })], c, [bar]).ok,
    ).toBe(true);
    // A 00:30 block belongs to that same past-midnight interval
    expect(
      validateItinerary([makeBlock({ startTime: '00:30', durationMin: 60 })], c, [bar]).ok,
    ).toBe(true);
    expect(
      codes(
        validateItinerary([makeBlock({ startTime: '03:00', durationMin: 60 })], c, [bar])
          .violations,
      ),
    ).toEqual(['outside_opening_hours']);
  });

  it('reports nothing when openingHours is missing', () => {
    const c = constraintsWith();
    const unknown = makePlace({ id: 'p1', openingHours: null });
    expect(validateItinerary([makeBlock({ startTime: '03:00' })], c, [unknown]).ok).toBe(true);
  });

  it('skips the opening-hours checks when given only ids, and runs the rest', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ startTime: '23:00', durationMin: 60 })];

    // Passing Place[] surfaces the violation
    expect(codes(validateItinerary(blocks, c, [openMonday9to18]).violations)).toEqual([
      'outside_opening_hours',
    ]);
    // Ids alone cannot answer the opening-hours question, but placeId is still checked
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
    expect(codes(validateItinerary(blocks, c, ['other']).violations)).toEqual(['unknown_place']);
  });

  it('accepts a Set of ids', () => {
    const c = constraintsWith();
    expect(validateItinerary([makeBlock()], c, new Set(['p1'])).ok).toBe(true);
  });
});

describe('validateItinerary — forced items must appear', () => {
  it('matches against the block title', () => {
    const c = constraintsWith({ forced: ['Universal Studios'] });
    const blocks = [makeBlock({ title: 'Universal Studios day trip' })];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('matches against the subtitle', () => {
    const c = constraintsWith({ forced: ['teamLab'] });
    const blocks = [makeBlock({ title: 'Digital art', subtitle: 'Two hours at teamLab' })];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('matches against the candidate place name when Place[] is supplied', () => {
    const c = constraintsWith({ forced: ['Dotonbori'] });
    const place = makePlace({ id: 'p1', name: 'Dotonbori' });
    expect(validateItinerary([makeBlock({ title: 'Dinner' })], c, [place]).ok).toBe(true);
  });

  it('matches case-insensitively', () => {
    const c = constraintsWith({ forced: ['TeamLab'] });
    expect(validateItinerary([makeBlock({ title: 'teamlab botanical' })], c, ['p1']).ok).toBe(true);
  });

  it('reports one violation per missing item', () => {
    const c = constraintsWith({ forced: ['Universal Studios', 'Dotonbori'] });
    const result = validateItinerary([makeBlock({ title: 'Osaka Castle' })], c, ['p1']);
    expect(codes(result.violations)).toEqual(['missing_forced', 'missing_forced']);
    expect(result.violations.map((v) => v.detail?.['item'])).toEqual([
      'Universal Studios',
      'Dotonbori',
    ]);
  });

  it('reports every forced item when the itinerary is empty', () => {
    const c = constraintsWith({ forced: ['Universal Studios'] });
    expect(codes(validateItinerary([], c, ['p1']).violations)).toEqual(['missing_forced']);
  });
});

describe('validateItinerary — bad data', () => {
  it('flags a day outside the trip range', () => {
    const c = constraintsWith(); // days = 3
    expect(codes(validateItinerary([makeBlock({ day: 4 })], c, ['p1']).violations)).toEqual([
      'invalid_day',
    ]);
    expect(codes(validateItinerary([makeBlock({ day: 0 })], c, ['p1']).violations)).toEqual([
      'invalid_day',
    ]);
  });

  it('flags an unreadable time without affecting the other blocks', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'bad', startTime: 'later' }),
      makeBlock({ id: 'ok', startTime: '14:00' }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['invalid_time']);
    expect(result.violations[0]?.blockId).toBe('bad');
  });

  it('flags a negative duration', () => {
    const c = constraintsWith();
    expect(
      codes(validateItinerary([makeBlock({ durationMin: -30 })], c, ['p1']).violations),
    ).toEqual(['invalid_time']);
  });

  it('returns every violation at once instead of stopping at the first', () => {
    const c = constraintsWith({ budgetCeiling: 100, forced: ['Universal Studios'] });
    const blocks = [
      makeBlock({ id: 'a', startTime: '10:00', durationMin: 120, costPerPerson: 200 }),
      makeBlock({ id: 'b', startTime: '11:00', placeId: 'ghost', costPerPerson: 50 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(result.ok).toBe(false);
    expect(new Set(codes(result.violations))).toEqual(
      new Set(['unknown_place', 'over_budget', 'overlap', 'missing_forced']),
    );
  });

  it('never throws, even on entirely malformed input', () => {
    const c = constraintsWith();
    expect(() =>
      validateItinerary(
        [null, undefined, { id: 'x' }] as unknown as Block[],
        c,
        null as unknown as string[],
      ),
    ).not.toThrow();
    expect(() => validateItinerary(null as unknown as Block[], c, ['p1'])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. enforceBudget
// ---------------------------------------------------------------------------

describe('enforceBudget', () => {
  it('leaves an already-affordable itinerary alone', () => {
    const c = constraintsWith({ budgetCeiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', costPerPerson: 100 }),
      makeBlock({ id: 'b', costPerPerson: 100 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['a', 'b']);
  });

  it('cuts most expensive first and stops once it fits', () => {
    const c = constraintsWith({ budgetCeiling: 100 });
    const blocks = [
      makeBlock({ id: 'a', costPerPerson: 50 }),
      makeBlock({ id: 'b', costPerPerson: 60 }),
      makeBlock({ id: 'c', costPerPerson: 30 }),
    ];
    const kept = enforceBudget(blocks, c);
    expect(ids(kept)).toEqual(['a', 'c']); // b (the priciest) goes, 80 <= 100, order preserved
    expect(totalCost(kept)).toBeLessThanOrEqual(100);
  });

  it('stops as soon as the total lands exactly on the ceiling', () => {
    const c = constraintsWith({ budgetCeiling: 100 });
    const blocks = [
      makeBlock({ id: 'a', costPerPerson: 60 }),
      makeBlock({ id: 'b', costPerPerson: 55 }),
      makeBlock({ id: 'c', costPerPerson: 45 }),
    ];
    const kept = enforceBudget(blocks, c); // 160 - 60 = 100, right on the line
    expect(ids(kept)).toEqual(['b', 'c']);
    expect(totalCost(kept)).toBe(100);
  });

  it('never cuts a locked block — an all-locked day stays untouched', () => {
    const c = constraintsWith({ budgetCeiling: 10 });
    const blocks = [
      makeBlock({ id: 'a', costPerPerson: 500, locked: true }),
      makeBlock({ id: 'b', costPerPerson: 400, locked: true }),
    ];
    const kept = enforceBudget(blocks, c);
    expect(ids(kept)).toEqual(['a', 'b']);
    // Nothing can be done here, so validateItinerary is left to report it
    expect(codes(validateItinerary(kept, c, ['p1']).violations)).toContain('over_budget');
  });

  it('cuts the second most expensive when the priciest block is locked', () => {
    const c = constraintsWith({ budgetCeiling: 100 });
    const blocks = [
      makeBlock({ id: 'locked', costPerPerson: 70, locked: true }),
      makeBlock({ id: 'b', costPerPerson: 60 }),
      makeBlock({ id: 'c', costPerPerson: 30 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['locked', 'c']);
  });

  it('breaks cost ties on the later startTime, deterministically', () => {
    const c = constraintsWith({ budgetCeiling: 100 });
    const blocks = [
      makeBlock({ id: 'morning', startTime: '09:00', costPerPerson: 60 }),
      makeBlock({ id: 'evening', startTime: '19:00', costPerPerson: 60 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['morning']);
    expect(ids(enforceBudget(blocks, c))).toEqual(ids(enforceBudget(blocks, c)));
  });

  it('leaves zero-cost blocks alone since cutting them saves nothing', () => {
    const c = constraintsWith({ budgetCeiling: 50 });
    const blocks = [
      makeBlock({ id: 'locked', costPerPerson: 100, locked: true }),
      makeBlock({ id: 'free', costPerPerson: 0 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['locked', 'free']);
  });

  it('cuts mustDo blocks last when protectForced is on', () => {
    const c = constraintsWith({ budgetCeiling: 100, forced: ['Universal Studios'] });
    const blocks = [
      makeBlock({ id: 'usj', title: 'Universal Studios', costPerPerson: 90 }),
      makeBlock({ id: 'aq', title: 'Osaka Aquarium', startTime: '15:00', costPerPerson: 80 }),
    ];
    // Default is literal §7: cost only, so the priciest (usj) goes first
    expect(ids(enforceBudget(blocks, c))).toEqual(['aq']);
    // With protection on, aq goes instead and the mustDo survives
    expect(ids(enforceBudget(blocks, c, { protectForced: true }))).toEqual(['usj']);
  });

  it('returns a new array and does not mutate the input', () => {
    const c = constraintsWith({ budgetCeiling: 100 });
    const blocks = [makeBlock({ id: 'a', costPerPerson: 200 })];
    const kept = enforceBudget(blocks, c);
    expect(kept).not.toBe(blocks);
    expect(blocks).toHaveLength(1);
    expect(kept).toEqual([]);
  });

  it('preserves extra fields the caller carries on its own type', () => {
    const c = constraintsWith({ budgetCeiling: 100 });
    const blocks = [{ ...makeBlock({ id: 'a', costPerPerson: 50 }), reason: { budget: 'ok' } }];
    const [first] = enforceBudget(blocks, c);
    expect(first?.reason).toEqual({ budget: 'ok' });
  });

  it('never throws on malformed input', () => {
    const c = constraintsWith({ budgetCeiling: 100 });
    expect(() => enforceBudget(null as unknown as Block[], c)).not.toThrow();
    expect(enforceBudget([null, undefined] as unknown as Block[], c)).toEqual([]);
  });
});

describe('validateItinerary — locked_over_budget', () => {
  it('flags locked blocks that bust the ceiling on their own', () => {
    const c = constraintsWith({ budgetCeiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', day: 1, startTime: '09:00', costPerPerson: 250, locked: true }),
      makeBlock({ id: 'b', day: 1, startTime: '13:00', costPerPerson: 200, locked: true }),
    ];
    const found = codes(validateItinerary(blocks, c, ['p1']).violations);
    expect(found).toContain('locked_over_budget');
    // over_budget still fires too — one says "you are over", the other says "and you
    // cannot fix it by cutting"
    expect(found).toContain('over_budget');
  });

  it('stays quiet when the locked blocks fit and only the free ones push it over', () => {
    const c = constraintsWith({ budgetCeiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', day: 1, startTime: '09:00', costPerPerson: 200, locked: true }),
      makeBlock({ id: 'b', day: 1, startTime: '13:00', costPerPerson: 250, locked: false }),
    ];
    const found = codes(validateItinerary(blocks, c, ['p1']).violations);
    expect(found).toContain('over_budget');
    expect(found).not.toContain('locked_over_budget');
  });

  it('is what enforceBudget cannot fix — the pair are consistent', () => {
    const c = constraintsWith({ budgetCeiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', day: 1, startTime: '09:00', costPerPerson: 250, locked: true }),
      makeBlock({ id: 'b', day: 1, startTime: '13:00', costPerPerson: 200, locked: true }),
    ];
    // enforceBudget returns without looping and without cutting anything...
    const trimmed = enforceBudget(blocks, c);
    expect(ids(trimmed)).toEqual(['a', 'b']);
    // ...and validateItinerary explains why the result is still over
    expect(codes(validateItinerary(trimmed, c, ['p1']).violations)).toContain(
      'locked_over_budget',
    );
  });
});

// ---------------------------------------------------------------------------
// End to end: the full post-generation check from §7 step 7
// ---------------------------------------------------------------------------

describe('enforceBudget feeding validateItinerary', () => {
  it('clears over_budget once the trimming has run', () => {
    const c = buildConstraints(TRIP, [
      makePref({ budgetBand: 'low' }), // sets the ceiling for everyone
      makePref({ budgetBand: 'high' }),
    ]);
    const places = [makePlace({ id: 'p1', openingHours: null })];
    const blocks = [
      makeBlock({ id: 'a', day: 1, startTime: '09:00', costPerPerson: 500 }),
      makeBlock({ id: 'b', day: 1, startTime: '13:00', costPerPerson: 400 }),
      makeBlock({ id: 'c', day: 2, startTime: '09:00', costPerPerson: 300 }),
    ];

    expect(c.budgetCeiling).toBe(bandCeiling('low', TRIP.budgetPerPerson));
    expect(codes(validateItinerary(blocks, c, places).violations)).toContain('over_budget');

    const trimmed = enforceBudget(blocks, c);
    expect(totalCost(trimmed)).toBeLessThanOrEqual(c.budgetCeiling);
    expect(validateItinerary(trimmed, c, places)).toEqual({ ok: true, violations: [] });
  });
});
