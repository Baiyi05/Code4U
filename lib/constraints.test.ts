import { describe, expect, it } from 'vitest';

import {
  BAND_CEILING,
  buildConstraints,
  enforceBudget,
  filterCandidates,
  totalCost,
  validateItinerary,
  type Block,
  type Constraints,
  type Place,
  type Preference,
  type Trip,
  type ViolationCode,
} from './constraints';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 2026-09-07 (Monday) – 09-09 (Wednesday), 3 days */
const TRIP: Trip = {
  id: 'trip-1',
  slug: 'OSK-4K2',
  destination: 'Osaka',
  city_key: 'osaka',
  start_date: '2026-09-07',
  end_date: '2026-09-09',
  budget_per_person: 1200,
};

let memberSeq = 0;
function makePref(over: Partial<Preference> = {}): Preference {
  memberSeq += 1;
  return {
    member_id: `m${memberSeq}`,
    trip_id: TRIP.id,
    budget_band: null,
    pace: null,
    interests: null,
    dietary: null,
    must_do: null,
    no_go: null,
    ...over,
  };
}

function makePlace(over: Partial<Place> = {}): Place {
  return {
    id: 'p1',
    city_key: 'osaka',
    name: 'Osaka Castle',
    category: 'sight',
    district: 'chuo',
    lat: null,
    lng: null,
    opening_hours: null,
    est_cost_per_person: 0,
    avg_duration_min: 60,
    indoor: false,
    veg_friendly: false,
    ...over,
  };
}

function makeBlock(over: Partial<Block> = {}): Block {
  return {
    id: 'b1',
    day: 1,
    start_time: '10:00',
    duration_min: 60,
    title: 'Osaka Castle',
    subtitle: null,
    place_id: 'p1',
    cost_per_person: 0,
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

describe('buildConstraints — budget_ceiling', () => {
  it('takes the lowest member ceiling, not the average', () => {
    const c = buildConstraints(TRIP, [
      makePref({ budget_band: 'low' }),
      makePref({ budget_band: 'mid' }),
      makePref({ budget_band: 'high' }),
    ]);

    expect(c.budget_ceiling).toBe(BAND_CEILING.low);

    // Pin down "not the average" explicitly — spec §7 calls this rule out by name
    const average = (BAND_CEILING.low + BAND_CEILING.mid + BAND_CEILING.high) / 3;
    expect(c.budget_ceiling).not.toBe(average);
    expect(c.budget_ceiling).toBeLessThan(average);
  });

  it('does not depend on member order', () => {
    const low = makePref({ budget_band: 'low' });
    const high = makePref({ budget_band: 'high' });
    expect(buildConstraints(TRIP, [low, high]).budget_ceiling).toBe(
      buildConstraints(TRIP, [high, low]).budget_ceiling,
    );
  });

  it('counts a missing or invalid band as mid', () => {
    expect(buildConstraints(TRIP, [makePref({ budget_band: null })]).budget_ceiling).toBe(
      BAND_CEILING.mid,
    );
    expect(
      buildConstraints(TRIP, [makePref({ budget_band: 'luxury' as never })]).budget_ceiling,
    ).toBe(BAND_CEILING.mid);
    // and it still takes part in the minimum
    expect(
      buildConstraints(TRIP, [makePref({ budget_band: null }), makePref({ budget_band: 'low' })])
        .budget_ceiling,
    ).toBe(BAND_CEILING.low);
  });

  it('falls back to trip.budget_per_person when there are no preferences at all', () => {
    expect(buildConstraints(TRIP, []).budget_ceiling).toBe(TRIP.budget_per_person);
    expect(buildConstraints(TRIP).budget_ceiling).toBe(TRIP.budget_per_person);
  });

  it('lets the band → amount mapping be overridden', () => {
    const c = buildConstraints(TRIP, [makePref({ budget_band: 'low' })], {
      bandCeiling: { low: 300, mid: 600, high: 900 },
    });
    expect(c.budget_ceiling).toBe(300);
  });
});

describe('buildConstraints — blocks_per_day', () => {
  it('follows the majority pace: chill 3 / balanced 4 / packed 5', () => {
    const chill = buildConstraints(TRIP, [
      makePref({ pace: 'chill' }),
      makePref({ pace: 'chill' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(chill.pace).toBe('chill');
    expect(chill.blocks_per_day).toBe(3);

    const balanced = buildConstraints(TRIP, [
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'chill' }),
    ]);
    expect(balanced.pace).toBe('balanced');
    expect(balanced.blocks_per_day).toBe(4);

    const packed = buildConstraints(TRIP, [
      makePref({ pace: 'packed' }),
      makePref({ pace: 'packed' }),
      makePref({ pace: 'chill' }),
    ]);
    expect(packed.pace).toBe('packed');
    expect(packed.blocks_per_day).toBe(5);
  });

  it('falls back to balanced on a tie: chill x1 vs packed x1', () => {
    const c = buildConstraints(TRIP, [makePref({ pace: 'chill' }), makePref({ pace: 'packed' })]);
    expect(c.pace).toBe('balanced');
    expect(c.blocks_per_day).toBe(4);
  });

  it('falls back to balanced on a tie: balanced x2 vs packed x2', () => {
    const c = buildConstraints(TRIP, [
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'packed' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(c.pace).toBe('balanced');
    expect(c.blocks_per_day).toBe(4);
  });

  it('falls back to balanced even when neither tied side is balanced: chill x2 vs packed x2', () => {
    const c = buildConstraints(TRIP, [
      makePref({ pace: 'chill' }),
      makePref({ pace: 'chill' }),
      makePref({ pace: 'packed' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(c.pace).toBe('balanced');
    expect(c.blocks_per_day).toBe(4);
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
    expect(c.blocks_per_day).toBe(3);
  });
});

describe('buildConstraints — tag unions', () => {
  it('required_tags is the union of everyone dietary, deduped case-insensitively', () => {
    const c = buildConstraints(TRIP, [
      makePref({ dietary: ['halal', 'vegetarian'] }),
      makePref({ dietary: ['Halal', '  ', 'no pork'] }),
      makePref({ dietary: null }),
    ]);
    expect(c.required_tags).toEqual(['halal', 'vegetarian', 'no pork']);
  });

  it('forced collects every must_do, split on separators', () => {
    const c = buildConstraints(TRIP, [
      makePref({ must_do: 'Universal Studios, Dotonbori' }),
      makePref({ must_do: 'teamLab; Universal Studios' }),
      makePref({ must_do: '   ' }),
    ]);
    expect(c.forced).toEqual(['Universal Studios', 'Dotonbori', 'teamLab']);
  });

  it('excluded is the union of everyone no_go', () => {
    const c = buildConstraints(TRIP, [
      makePref({ no_go: 'nightclub; casino' }),
      makePref({ no_go: 'nightclub\nseafood' }),
    ]);
    expect(c.excluded).toEqual(['nightclub', 'casino', 'seafood']);
  });

  it('splits full-width separators too (members may type in any locale)', () => {
    const c = buildConstraints(TRIP, [makePref({ no_go: 'casino，nightclub、seafood' })]);
    expect(c.excluded).toEqual(['casino', 'nightclub', 'seafood']);
  });

  it('lets the splitter be overridden', () => {
    const c = buildConstraints(TRIP, [makePref({ no_go: 'a|b' })], {
      splitFreeText: (v) => v.split('|'),
    });
    expect(c.excluded).toEqual(['a', 'b']);
  });

  it('returns empty arrays when nobody filled anything in', () => {
    const c = buildConstraints(TRIP, [makePref()]);
    expect(c.required_tags).toEqual([]);
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
      buildConstraints({ ...TRIP, start_date: '2026-09-07', end_date: '2026-09-07' }, []).days,
    ).toBe(1);
  });

  it('spans month boundaries correctly', () => {
    expect(
      buildConstraints({ ...TRIP, start_date: '2026-08-30', end_date: '2026-09-02' }, []).days,
    ).toBe(4);
  });

  it('falls back to 1 day on invalid dates instead of throwing', () => {
    expect(buildConstraints({ ...TRIP, end_date: '2026-02-30' }, []).days).toBe(1);
    expect(buildConstraints({ ...TRIP, start_date: 'tomorrow' }, []).days).toBe(1);
  });

  it('passes city_key and start_date straight through', () => {
    const c = buildConstraints(TRIP, []);
    expect(c.city_key).toBe('osaka');
    expect(c.start_date).toBe('2026-09-07');
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

  it('ignores a single-ASCII-character no_go (a "b" must not drop every bar)', () => {
    const c = constraintsWith({ excluded: ['b'] });
    const places = [makePlace({ id: 'bar', category: 'bar' })];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['bar']);
  });

  it('still honours a single-glyph no_go from a non-ASCII script', () => {
    // Prefetched Osaka POIs carry Japanese names, and one glyph there is a whole word
    const c = constraintsWith({ excluded: ['酒'] });
    const places = [makePlace({ id: 'drop', category: '居酒屋' }), makePlace({ id: 'keep' })];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['keep']);
  });

  it('drops places from other cities', () => {
    const c = constraintsWith();
    const places = [makePlace({ id: 'osk' }), makePlace({ id: 'kul', city_key: 'kualalumpur' })];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['osk']);
  });

  it('drops places closed that day: the weekday is absent from periods', () => {
    const c = constraintsWith();
    // Day 1 is 2026-09-07, a Monday (weekday 1); this place only lists Tuesday
    const closedOnMonday = makePlace({
      id: 'tue-only',
      opening_hours: { periods: { 2: [{ open: '09:00', close: '18:00' }] } },
    });
    expect(filterCandidates([closedOnMonday], c, 1)).toEqual([]);
    expect(filterCandidates([closedOnMonday], c, 2).map((p) => p.id)).toEqual(['tue-only']);
  });

  it('drops places closed that day: the weekday maps to an empty array', () => {
    const c = constraintsWith();
    const place = makePlace({
      id: 'x',
      opening_hours: { periods: { 1: [], 2: [{ open: '09:00', close: '18:00' }] } },
    });
    expect(filterCandidates([place], c, 1)).toEqual([]);
    expect(filterCandidates([place], c, 2).map((p) => p.id)).toEqual(['x']);
  });

  it('lets exceptions override periods (one-off closure)', () => {
    const c = constraintsWith();
    const place = makePlace({
      id: 'x',
      opening_hours: {
        periods: { 1: [{ open: '09:00', close: '18:00' }] },
        exceptions: { '2026-09-07': [] },
      },
    });
    expect(filterCandidates([place], c, 1)).toEqual([]);
  });

  it('keeps places with missing opening_hours (never wash the candidate pool out)', () => {
    const c = constraintsWith();
    const unknown = makePlace({ id: 'unknown', opening_hours: null });
    const garbage = makePlace({
      id: 'garbage',
      opening_hours: { periods: { 1: [{ open: '???', close: '???' }] } },
    });
    expect(filterCandidates([unknown, garbage], c, 1).map((p) => p.id)).toEqual([
      'unknown',
      'garbage',
    ]);
  });

  it('always keeps an always_open place', () => {
    const c = constraintsWith();
    const place = makePlace({ id: 'x', opening_hours: { always_open: true, periods: { 2: [] } } });
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

describe('validateItinerary — place_id must come from the candidates', () => {
  it('reports nothing for a clean itinerary', () => {
    const c = constraintsWith({ budget_ceiling: 500 });
    const places = [makePlace({ id: 'p1' })];
    const blocks = [makeBlock({ place_id: 'p1', cost_per_person: 100 })];
    expect(validateItinerary(blocks, c, places)).toEqual({ ok: true, violations: [] });
  });

  it('flags a place the LLM invented', () => {
    const c = constraintsWith();
    const result = validateItinerary([makeBlock({ place_id: 'hallucinated' })], c, ['p1']);
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toEqual(['unknown_place']);
    expect(result.violations[0]?.detail).toMatchObject({ place_id: 'hallucinated' });
  });

  it('flags a block with no place_id', () => {
    const c = constraintsWith();
    const result = validateItinerary([makeBlock({ place_id: null })], c, ['p1']);
    expect(codes(result.violations)).toEqual(['missing_place']);
  });
});

describe('validateItinerary — budget', () => {
  it('passes when the total lands exactly on the ceiling', () => {
    const c = constraintsWith({ budget_ceiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 200 }),
      makeBlock({ id: 'b', start_time: '14:00', cost_per_person: 100 }),
    ];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('flags a total one unit over the ceiling', () => {
    const c = constraintsWith({ budget_ceiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 200 }),
      makeBlock({ id: 'b', start_time: '14:00', cost_per_person: 101 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['over_budget']);
    expect(result.violations[0]?.detail).toMatchObject({ total: 301, ceiling: 300, over: 1 });
  });

  it('sums across the whole trip, not per day', () => {
    const c = constraintsWith({ budget_ceiling: 150 });
    const blocks = [
      makeBlock({ id: 'a', day: 1, cost_per_person: 100 }),
      makeBlock({ id: 'b', day: 2, cost_per_person: 100 }),
    ];
    expect(codes(validateItinerary(blocks, c, ['p1']).violations)).toContain('over_budget');
  });
});

describe('validateItinerary — no overlaps within a day', () => {
  it('catches an overlap', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'a', start_time: '10:00', duration_min: 120 }),
      makeBlock({ id: 'b', start_time: '11:00', duration_min: 60 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['overlap']);
    expect(result.violations[0]).toMatchObject({ day: 1, detail: { with_block_id: 'b' } });
  });

  it('treats back-to-back blocks as fine', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'a', start_time: '10:00', duration_min: 60 }),
      makeBlock({ id: 'b', start_time: '11:00', duration_min: 60 }),
    ];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('does not treat the same slot on different days as an overlap', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'a', day: 1, start_time: '10:00' }),
      makeBlock({ id: 'b', day: 2, start_time: '10:00' }),
    ];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('reports both pairs when one long block swallows two short ones', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'big', start_time: '09:00', duration_min: 300 }),
      makeBlock({ id: 's1', start_time: '10:00', duration_min: 30 }),
      makeBlock({ id: 's2', start_time: '12:00', duration_min: 30 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['overlap', 'overlap']);
  });
});

describe('validateItinerary — opening hours', () => {
  const openMonday9to18 = makePlace({
    id: 'p1',
    name: 'Osaka Castle',
    opening_hours: { periods: { 1: [{ open: '09:00', close: '18:00' }] } },
  });

  it('passes when the block sits entirely inside the opening hours', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ start_time: '10:00', duration_min: 120 })];
    expect(validateItinerary(blocks, c, [openMonday9to18]).ok).toBe(true);
  });

  it('flags a block that runs past closing time', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ start_time: '17:00', duration_min: 120 })];
    const result = validateItinerary(blocks, c, [openMonday9to18]);
    expect(codes(result.violations)).toEqual(['outside_opening_hours']);
    expect(result.violations[0]?.detail).toMatchObject({ block: '17:00-19:00' });
  });

  it('flags a block scheduled before opening time', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ start_time: '08:00', duration_min: 30 })];
    expect(codes(validateItinerary(blocks, c, [openMonday9to18]).violations)).toEqual([
      'outside_opening_hours',
    ]);
  });

  it('flags a place that is closed all day', () => {
    const c = constraintsWith();
    // Open Tuesdays only, while day 1 of the trip is a Monday
    const tuesdayOnly = makePlace({
      id: 'p1',
      opening_hours: { periods: { 2: [{ open: '09:00', close: '18:00' }] } },
    });
    expect(codes(validateItinerary([makeBlock()], c, [tuesdayOnly]).violations)).toEqual([
      'closed_that_day',
    ]);
  });

  it('handles past-midnight hours: an 18:00–02:00 venue accepts a 23:00 block', () => {
    const c = constraintsWith();
    const bar = makePlace({
      id: 'p1',
      opening_hours: { periods: { 1: [{ open: '18:00', close: '02:00' }] } },
    });
    expect(
      validateItinerary([makeBlock({ start_time: '23:00', duration_min: 90 })], c, [bar]).ok,
    ).toBe(true);
    // A 00:30 block belongs to that same past-midnight interval
    expect(
      validateItinerary([makeBlock({ start_time: '00:30', duration_min: 60 })], c, [bar]).ok,
    ).toBe(true);
    expect(
      codes(
        validateItinerary([makeBlock({ start_time: '03:00', duration_min: 60 })], c, [bar])
          .violations,
      ),
    ).toEqual(['outside_opening_hours']);
  });

  it('reports nothing when opening_hours is missing', () => {
    const c = constraintsWith();
    const unknown = makePlace({ id: 'p1', opening_hours: null });
    expect(validateItinerary([makeBlock({ start_time: '03:00' })], c, [unknown]).ok).toBe(true);
  });

  it('skips the opening-hours checks when given only ids, and runs the rest', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ start_time: '23:00', duration_min: 60 })];

    // Passing Place[] surfaces the violation
    expect(codes(validateItinerary(blocks, c, [openMonday9to18]).violations)).toEqual([
      'outside_opening_hours',
    ]);
    // Ids alone cannot answer the opening-hours question, but place_id is still checked
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
      makeBlock({ id: 'bad', start_time: 'later' }),
      makeBlock({ id: 'ok', start_time: '14:00' }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['invalid_time']);
    expect(result.violations[0]?.block_id).toBe('bad');
  });

  it('flags a negative duration', () => {
    const c = constraintsWith();
    expect(
      codes(validateItinerary([makeBlock({ duration_min: -30 })], c, ['p1']).violations),
    ).toEqual(['invalid_time']);
  });

  it('returns every violation at once instead of stopping at the first', () => {
    const c = constraintsWith({ budget_ceiling: 100, forced: ['Universal Studios'] });
    const blocks = [
      makeBlock({ id: 'a', start_time: '10:00', duration_min: 120, cost_per_person: 200 }),
      makeBlock({ id: 'b', start_time: '11:00', place_id: 'ghost', cost_per_person: 50 }),
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
    const c = constraintsWith({ budget_ceiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 100 }),
      makeBlock({ id: 'b', cost_per_person: 100 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['a', 'b']);
  });

  it('cuts most expensive first and stops once it fits', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 50 }),
      makeBlock({ id: 'b', cost_per_person: 60 }),
      makeBlock({ id: 'c', cost_per_person: 30 }),
    ];
    const kept = enforceBudget(blocks, c);
    expect(ids(kept)).toEqual(['a', 'c']); // b (the priciest) goes, 80 <= 100, order preserved
    expect(totalCost(kept)).toBeLessThanOrEqual(100);
  });

  it('stops as soon as the total lands exactly on the ceiling', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 60 }),
      makeBlock({ id: 'b', cost_per_person: 55 }),
      makeBlock({ id: 'c', cost_per_person: 45 }),
    ];
    const kept = enforceBudget(blocks, c); // 160 - 60 = 100, right on the line
    expect(ids(kept)).toEqual(['b', 'c']);
    expect(totalCost(kept)).toBe(100);
  });

  it('never cuts a locked block — an all-locked day stays untouched', () => {
    const c = constraintsWith({ budget_ceiling: 10 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 500, locked: true }),
      makeBlock({ id: 'b', cost_per_person: 400, locked: true }),
    ];
    const kept = enforceBudget(blocks, c);
    expect(ids(kept)).toEqual(['a', 'b']);
    // Nothing can be done here, so validateItinerary is left to report it
    expect(codes(validateItinerary(kept, c, ['p1']).violations)).toContain('over_budget');
  });

  it('cuts the second most expensive when the priciest block is locked', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [
      makeBlock({ id: 'locked', cost_per_person: 70, locked: true }),
      makeBlock({ id: 'b', cost_per_person: 60 }),
      makeBlock({ id: 'c', cost_per_person: 30 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['locked', 'c']);
  });

  it('breaks cost ties on the later start_time, deterministically', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [
      makeBlock({ id: 'morning', start_time: '09:00', cost_per_person: 60 }),
      makeBlock({ id: 'evening', start_time: '19:00', cost_per_person: 60 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['morning']);
    expect(ids(enforceBudget(blocks, c))).toEqual(ids(enforceBudget(blocks, c)));
  });

  it('leaves zero-cost blocks alone since cutting them saves nothing', () => {
    const c = constraintsWith({ budget_ceiling: 50 });
    const blocks = [
      makeBlock({ id: 'locked', cost_per_person: 100, locked: true }),
      makeBlock({ id: 'free', cost_per_person: 0 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['locked', 'free']);
  });

  it('cuts must_do blocks last when protectForced is on', () => {
    const c = constraintsWith({ budget_ceiling: 100, forced: ['Universal Studios'] });
    const blocks = [
      makeBlock({ id: 'usj', title: 'Universal Studios', cost_per_person: 90 }),
      makeBlock({ id: 'aq', title: 'Osaka Aquarium', start_time: '15:00', cost_per_person: 80 }),
    ];
    // Default is literal §7: cost only, so the priciest (usj) goes first
    expect(ids(enforceBudget(blocks, c))).toEqual(['aq']);
    // With protection on, aq goes instead and the must_do survives
    expect(ids(enforceBudget(blocks, c, { protectForced: true }))).toEqual(['usj']);
  });

  it('returns a new array and does not mutate the input', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [makeBlock({ id: 'a', cost_per_person: 200 })];
    const kept = enforceBudget(blocks, c);
    expect(kept).not.toBe(blocks);
    expect(blocks).toHaveLength(1);
    expect(kept).toEqual([]);
  });

  it('preserves extra fields the caller carries on its own type', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [{ ...makeBlock({ id: 'a', cost_per_person: 50 }), reason: { budget: 'ok' } }];
    const [first] = enforceBudget(blocks, c);
    expect(first?.reason).toEqual({ budget: 'ok' });
  });

  it('never throws on malformed input', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    expect(() => enforceBudget(null as unknown as Block[], c)).not.toThrow();
    expect(enforceBudget([null, undefined] as unknown as Block[], c)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End to end: the full post-generation check from §7 step 7
// ---------------------------------------------------------------------------

describe('enforceBudget feeding validateItinerary', () => {
  it('clears over_budget once the trimming has run', () => {
    const c = buildConstraints(TRIP, [
      makePref({ budget_band: 'low' }), // ceiling = 800
      makePref({ budget_band: 'high' }),
    ]);
    const places = [makePlace({ id: 'p1', opening_hours: null })];
    const blocks = [
      makeBlock({ id: 'a', day: 1, start_time: '09:00', cost_per_person: 500 }),
      makeBlock({ id: 'b', day: 1, start_time: '13:00', cost_per_person: 400 }),
      makeBlock({ id: 'c', day: 2, start_time: '09:00', cost_per_person: 300 }),
    ];

    expect(c.budget_ceiling).toBe(800);
    expect(codes(validateItinerary(blocks, c, places).violations)).toContain('over_budget');

    const trimmed = enforceBudget(blocks, c);
    expect(totalCost(trimmed)).toBeLessThanOrEqual(c.budget_ceiling);
    expect(validateItinerary(trimmed, c, places)).toEqual({ ok: true, violations: [] });
  });
});
