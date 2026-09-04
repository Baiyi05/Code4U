import { describe, expect, it } from 'vitest';

import { buildConstraints, totalCost, validateItinerary } from './constraints';
import {
  buildCandidatePool,
  buildQueries,
  fallbackToSeed,
  generateItinerary,
  type GenerateDeps,
} from './generate';
import { MockKnowledgeRetriever } from './__mocks__/knowledge';
import { MockLLMClient } from './__mocks__/llm';
import { FailingPlaceRepository, MockPlaceRepository } from './__mocks__/places';
import { SEED_ITINERARY, SEED_PLACES, seedAsDraft } from './seed';
import type { Block, ItineraryDraft, Preference, Trip, ViolationCode } from './schemas';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 2026-09-07 (Monday) – 09-11 (Friday), the same span the seed covers */
const TRIP: Trip = {
  id: 'trip-1',
  slug: 'OSK-1',
  destination: 'Osaka, Japan',
  cityKey: 'osaka',
  startDate: '2026-09-07',
  endDate: '2026-09-11',
  budgetPerPerson: 1000,
};

let prefSeq = 0;
function pref(over: Partial<Preference> = {}): Preference {
  prefSeq += 1;
  return {
    memberId: `m${prefSeq}`,
    tripId: TRIP.id,
    budgetBand: 'high', // ceiling lands exactly on trip.budgetPerPerson
    pace: 'balanced',
    interests: null,
    dietary: null,
    mustDo: null,
    noGo: null,
    ...over,
  };
}

/** Places that are open at every hour of every day, so hand-built blocks cannot
 *  trip the opening-hours check while some other rule is under test. */
const ALWAYS_OPEN = ['dotonbori', 'namba-sennichimae', 'nakanoshima-park', 'minoo-park'] as const;

function block(
  day: number,
  startTime: string,
  durationMin: number,
  placeId: string,
  costPerPerson: number,
  over: Partial<Block> = {},
): Block {
  return {
    id: `b-${day}-${startTime}`,
    tripId: TRIP.id,
    day,
    startTime,
    durationMin,
    title: `Block at ${placeId}`,
    subtitle: null,
    placeId,
    costPerPerson,
    locked: false,
    reason: null,
    sourceCitation: null,
    createdBy: 'ai',
    ...over,
  };
}

function draftOf(...blocks: Block[]): ItineraryDraft {
  return {
    blocks: blocks.map((b) => ({
      day: b.day,
      startTime: b.startTime,
      durationMin: b.durationMin,
      title: b.title,
      subtitle: null,
      placeId: b.placeId ?? '',
      costPerPerson: b.costPerPerson,
      reason: null,
      sourceCitation: null,
    })),
    summary: 'test draft',
  };
}

function deps(over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    llm: new MockLLMClient(),
    places: new MockPlaceRepository(),
    knowledge: new MockKnowledgeRetriever(),
    ...over,
  };
}

function codes(violations: ReadonlyArray<{ code: ViolationCode }>): ViolationCode[] {
  return violations.map((v) => v.code);
}

/** The seed's own trip and preferences — the only inputs it claims to be valid for */
const SEED_TRIP = SEED_ITINERARY.trip;
const SEED_PREFS = SEED_ITINERARY.preferences;

// ---------------------------------------------------------------------------
// The seed has to be legal. Everything else is downstream of this.
// ---------------------------------------------------------------------------

describe('seeds/osaka-trip.json', () => {
  it('passes validateItinerary against its own trip and preferences', () => {
    const c = buildConstraints(SEED_TRIP, SEED_PREFS);
    const pool = buildCandidatePool(SEED_PLACES, c);
    const result = validateItinerary(SEED_ITINERARY.blocks, c, pool.all);

    // Print the violations rather than just failing, so a future break is diagnosable
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('costs no more than the ceiling its own preferences produce', () => {
    // The invariant that stops the seed and the budget rule drifting apart. If
    // BAND_RATIO changes, or somebody makes the seed more expensive, this fails.
    const c = buildConstraints(SEED_TRIP, SEED_PREFS);
    expect(totalCost(SEED_ITINERARY.blocks)).toBeLessThanOrEqual(c.budgetCeiling);
  });

  it('is the shape the rest of the pipeline assumes: 4 people, 5 days, 20 blocks', () => {
    const c = buildConstraints(SEED_TRIP, SEED_PREFS);
    expect(SEED_ITINERARY.members).toHaveLength(4);
    expect(SEED_ITINERARY.blocks).toHaveLength(20);
    expect(c.days).toBe(5);
    expect(c.blocksPerDay).toBe(4);
    expect(c.pace).toBe('balanced');
    for (let day = 1; day <= 5; day += 1) {
      expect(SEED_ITINERARY.blocks.filter((b) => b.day === day)).toHaveLength(4);
    }
  });

  it('lets the lowest member set the ceiling, which is the rule it exists to demo', () => {
    const c = buildConstraints(SEED_TRIP, SEED_PREFS);
    expect(SEED_PREFS.some((p) => p.budgetBand === 'low')).toBe(true);
    expect(c.budgetCeiling).toBeLessThan(SEED_TRIP.budgetPerPerson);
  });

  it('does not fabricate a reason — no vote counts, no invented citation', () => {
    for (const b of SEED_ITINERARY.blocks) {
      // Fallback data was not chosen by anybody's vote, so it must not claim to be
      expect(b.reason?.votes ?? null).toBeNull();
      // ...and it must not attribute a quote to a source it never read
      expect(b.sourceCitation ?? null).toBeNull();
      expect(b.createdBy).toBe('seed');
    }
  });

  it('every block points at a place that exists in osaka-places.json', () => {
    const known = new Set(SEED_PLACES.map((p) => p.id));
    for (const b of SEED_ITINERARY.blocks) {
      expect(known.has(b.placeId ?? '')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §7 step 6 — schema failure and the one retry
// ---------------------------------------------------------------------------

describe('generateItinerary — retry on a bad reply', () => {
  it('retries once when the reply does not match the schema', async () => {
    const llm = new MockLLMClient({ responses: [{ nonsense: true }] });
    const result = await generateItinerary({ trip: SEED_TRIP, preferences: SEED_PREFS }, deps({ llm }));

    expect(llm.callCount).toBe(2);
    expect(result.source).toBe('llm-retry');
    expect(result.attempts[0]?.error).toContain('schema');
    expect(result.attempts[1]?.error).toBeNull();
  });

  it('sends a stricter prompt the second time, naming what went wrong', async () => {
    const llm = new MockLLMClient({ responses: [{ blocks: 'not an array' }] });
    await generateItinerary({ trip: SEED_TRIP, preferences: SEED_PREFS }, deps({ llm }));

    expect(llm.prompts[0]).not.toContain('YOUR PREVIOUS REPLY WAS REJECTED');
    expect(llm.prompts[1]).toContain('YOUR PREVIOUS REPLY WAS REJECTED');
  });

  it('falls back to the seed when the retry is bad too, without throwing', async () => {
    const llm = new MockLLMClient({ responses: [{ bad: 1 }, { alsoBad: 2 }] });
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );

    expect(llm.callCount).toBe(2);
    expect(result.source).toBe('seed');
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(20);
  });

  it('treats a thrown model call the same way — two tries, then the seed', async () => {
    const llm = new MockLLMClient({
      responses: [new Error('429 rate limited'), new Error('503 unavailable')],
    });
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );

    expect(result.source).toBe('seed');
    expect(result.attempts[0]?.error).toContain('429');
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it('recovers on the retry rather than falling back', async () => {
    const llm = new MockLLMClient({ responses: [{ garbage: true }] });
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );
    expect(result.source).toBe('llm-retry');
    expect(result.ok).toBe(true);
  });

  it('does not call the model twice when the first reply is good', async () => {
    const llm = new MockLLMClient();
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );
    expect(llm.callCount).toBe(1);
    expect(result.source).toBe('llm');
    expect(result.attempts).toHaveLength(1);
  });

  it('never throws, even when the places repository is down', async () => {
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ places: new FailingPlaceRepository() }),
    );
    // No candidates were ever loaded, so the seed cannot be validated against them
    // — it still comes back rather than blowing up.
    expect(result.source).toBe('seed');
    expect(() => result.blocks.length).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §7 step 7 — the anti-hallucination core
// ---------------------------------------------------------------------------

describe('generateItinerary — invented places', () => {
  /** Repoint the blocks at these indices at places that do not exist */
  function withInventedAt(indices: readonly number[]): ItineraryDraft {
    const hit = new Set(indices);
    const draft = seedAsDraft();
    return {
      ...draft,
      blocks: draft.blocks.map((b, i) =>
        hit.has(i) ? { ...b, placeId: `invented-place-${i}`, title: `Made-up stop ${i}` } : b,
      ),
    };
  }

  /** The seed puts 4 blocks on each day, so the first `count` all land on day 1 */
  function withInvented(count: number): ItineraryDraft {
    return withInventedAt([...Array(count).keys()]);
  }

  it('drops one invented block and returns the rest', async () => {
    const llm = new MockLLMClient({ responses: [withInvented(1)] });
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );

    expect(llm.callCount).toBe(1);
    expect(result.source).toBe('llm');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBe('unknown_place');
    expect(result.dropped[0]?.placeId).toBe('invented-place-0');
    expect(result.blocks).toHaveLength(19);
  });

  it('leaves nothing in the result pointing at a place that was not offered', async () => {
    const llm = new MockLLMClient({ responses: [withInvented(2)] });
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );

    const c = buildConstraints(SEED_TRIP, SEED_PREFS);
    const pool = buildCandidatePool(SEED_PLACES, c);
    for (const b of result.blocks) {
      expect(pool.ids.has(b.placeId ?? '')).toBe(true);
    }
    expect(codes(result.violations)).not.toContain('unknown_place');
  });

  it('escalates to the retry when half the blocks are invented', async () => {
    const llm = new MockLLMClient({ responses: [withInvented(10), withInvented(10)] });
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );

    expect(llm.callCount).toBe(2);
    expect(result.attempts[0]?.error).toContain('not offered');
    // Both attempts blew the threshold, so the seed is what comes back
    expect(result.source).toBe('seed');
    expect(result.ok).toBe(true);
  });

  it('keeps the retry when the model reads the candidate list the second time', async () => {
    const llm = new MockLLMClient({ responses: [withInvented(10)] });
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );
    expect(result.source).toBe('llm-retry');
    expect(result.dropped).toHaveLength(0);
  });

  it('tells the retry prompt to copy the ids exactly', async () => {
    const llm = new MockLLMClient({ responses: [withInvented(10)] });
    await generateItinerary({ trip: SEED_TRIP, preferences: SEED_PREFS }, deps({ llm }));
    expect(llm.prompts[1]).toContain('Copy them exactly');
  });

  it('escalates when a day is hollowed out, even under the ratio limit', async () => {
    // Three blocks on day 1, two of them invented: 2/3 dropped is over the ratio,
    // and the day is left with one — either trip-wire is enough on its own.
    const bad = draftOf(
      block(1, '09:00', 60, 'ghost-a', 0),
      block(1, '11:00', 60, 'ghost-b', 0),
      block(1, '13:00', 60, 'dotonbori', 0),
    );
    const llm = new MockLLMClient({ responses: [bad, bad] });
    const result = await generateItinerary(
      { trip: { ...TRIP, endDate: TRIP.startDate }, preferences: [pref()] },
      deps({ llm }),
    );
    expect(result.attempts[0]?.error).toBeTruthy();
    expect(llm.callCount).toBe(2);
  });

  it('hands the caller the whole dropped list rather than swallowing it', async () => {
    // One per day, so no single day falls under the two-block floor and the
    // 3-in-20 ratio stays inside the 20% limit
    const llm = new MockLLMClient({ responses: [withInventedAt([0, 4, 8])] });
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );
    expect(result.dropped).toHaveLength(3);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      'unknown_place',
      'unknown_place',
      'unknown_place',
    ]);
    expect(result.blocks).toHaveLength(17);
  });
});

// ---------------------------------------------------------------------------
// §7 step 7 — budget
// ---------------------------------------------------------------------------

describe('generateItinerary — budget', () => {
  it('cuts the most expensive blocks until the total fits', async () => {
    const over = draftOf(
      block(1, '09:00', 60, 'dotonbori', 600),
      block(1, '11:00', 60, 'namba-sennichimae', 500),
      block(1, '13:00', 60, 'nakanoshima-park', 100),
    );
    const llm = new MockLLMClient({ responses: [over] });
    const result = await generateItinerary(
      { trip: { ...TRIP, endDate: TRIP.startDate, budgetPerPerson: 700 }, preferences: [pref()] },
      deps({ llm }),
    );

    expect(result.constraints.budgetCeiling).toBe(700);
    expect(totalCost(result.blocks)).toBeLessThanOrEqual(700);
    expect(result.dropped.some((d) => d.reason === 'over_budget')).toBe(true);
    expect(codes(result.violations)).not.toContain('over_budget');
  });

  it('reports the over-budget cut instead of hiding it', async () => {
    const over = draftOf(
      block(1, '09:00', 60, 'dotonbori', 900),
      block(1, '11:00', 60, 'namba-sennichimae', 100),
      block(1, '13:00', 60, 'nakanoshima-park', 100),
    );
    const llm = new MockLLMClient({ responses: [over] });
    const result = await generateItinerary(
      { trip: { ...TRIP, endDate: TRIP.startDate, budgetPerPerson: 300 }, preferences: [pref()] },
      deps({ llm }),
    );
    const cut = result.dropped.filter((d) => d.reason === 'over_budget');
    expect(cut).toHaveLength(1);
    expect(cut[0]?.placeId).toBe('dotonbori');
  });
});

// ---------------------------------------------------------------------------
// Locked blocks — §7 step 7 plus the regeneration case
// ---------------------------------------------------------------------------

describe('generateItinerary — locked blocks', () => {
  const ONE_DAY: Trip = { ...TRIP, endDate: TRIP.startDate, budgetPerPerson: 700 };

  const LOCKED: Block[] = [
    block(1, '08:00', 60, 'minoo-park', 200, { id: 'locked-1', locked: true, title: 'Locked morning' }),
    block(1, '20:00', 60, 'dotonbori', 150, { id: 'locked-2', locked: true, title: 'Locked dinner' }),
  ];

  const FILLER = draftOf(
    block(1, '10:00', 60, 'namba-sennichimae', 100),
    block(1, '13:00', 60, 'nakanoshima-park', 100),
  );

  it('keeps locked blocks byte for byte', async () => {
    const llm = new MockLLMClient({ responses: [FILLER] });
    const result = await generateItinerary(
      { trip: ONE_DAY, preferences: [pref()], lockedBlocks: LOCKED },
      deps({ llm }),
    );

    for (const original of LOCKED) {
      const kept = result.blocks.find((b) => b.id === original.id);
      expect(kept).toEqual(original);
    }
    expect(result.blocks).toHaveLength(4);
  });

  it('tells the model what is already taken, and what is left to spend', async () => {
    const llm = new MockLLMClient({ responses: [FILLER] });
    await generateItinerary(
      { trip: ONE_DAY, preferences: [pref()], lockedBlocks: LOCKED },
      deps({ llm }),
    );

    const prompt = llm.prompts[0] ?? '';
    expect(prompt).toContain('ALREADY FIXED');
    expect(prompt).toContain('Locked morning');
    // 700 ceiling - 350 already committed
    expect(prompt).toContain('your budget is 350');
  });

  it('does not offer a place that a locked block already uses', async () => {
    const llm = new MockLLMClient({ responses: [FILLER] });
    await generateItinerary(
      { trip: ONE_DAY, preferences: [pref()], lockedBlocks: LOCKED },
      deps({ llm }),
    );

    const prompt = llm.prompts[0] ?? '';
    const candidateSection = prompt.slice(prompt.indexOf('CANDIDATE PLACES'));
    expect(candidateSection).not.toContain('minoo-park');
    expect(candidateSection).toContain('namba-sennichimae');
  });

  it('cuts non-locked blocks and leaves locked ones alone when over budget', async () => {
    const expensive = draftOf(
      block(1, '10:00', 60, 'namba-sennichimae', 400),
      block(1, '13:00', 60, 'nakanoshima-park', 300),
    );
    const llm = new MockLLMClient({ responses: [expensive] });
    const result = await generateItinerary(
      { trip: ONE_DAY, preferences: [pref()], lockedBlocks: LOCKED },
      deps({ llm }),
    );

    // 350 locked + 700 free = 1050, over the 700 ceiling
    expect(totalCost(result.blocks)).toBeLessThanOrEqual(700);
    expect(result.blocks.filter((b) => b.locked)).toHaveLength(2);
    expect(result.dropped.every((d) => d.placeId !== 'minoo-park')).toBe(true);
    for (const original of LOCKED) {
      expect(result.blocks.find((b) => b.id === original.id)).toEqual(original);
    }
  });

  it('says so, without looping, when the locked blocks alone bust the ceiling', async () => {
    const tiny: Trip = { ...ONE_DAY, budgetPerPerson: 100 };
    const llm = new MockLLMClient({ responses: [FILLER] });
    const result = await generateItinerary(
      { trip: tiny, preferences: [pref()], lockedBlocks: LOCKED },
      deps({ llm }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain('locked_over_budget');
    // The blocks still come back — the caller decides what to tell the user
    expect(result.blocks.filter((b) => b.locked)).toHaveLength(2);
  });

  it('behaves exactly as before when no locked blocks are passed', async () => {
    const llm = new MockLLMClient({ responses: [FILLER] });
    const withoutKey = await generateItinerary(
      { trip: ONE_DAY, preferences: [pref()] },
      deps({ llm }),
    );
    const llm2 = new MockLLMClient({ responses: [FILLER] });
    const withEmpty = await generateItinerary(
      { trip: ONE_DAY, preferences: [pref()], lockedBlocks: [] },
      deps({ llm: llm2 }),
    );

    expect(withoutKey.blocks).toEqual(withEmpty.blocks);
    expect(withoutKey.ok).toBe(true);
    expect(withoutKey.blocks).toHaveLength(2);
    expect(llm.prompts[0]).not.toContain('ALREADY FIXED');
  });
});

// ---------------------------------------------------------------------------
// The seed fallback, adapted to a trip it was not written for
// ---------------------------------------------------------------------------

describe('fallbackToSeed', () => {
  function constraintsFor(trip: Trip, prefs: Preference[] = SEED_PREFS) {
    return buildConstraints(trip, prefs);
  }

  it('trims the seed down to a shorter trip and re-runs the budget', () => {
    const shorter: Trip = { ...SEED_TRIP, endDate: '2026-09-09' }; // 3 days
    const c = constraintsFor(shorter);
    const pool = buildCandidatePool(SEED_PLACES, c);
    const fb = fallbackToSeed(c, SEED_ITINERARY, pool.all);

    expect(fb.source).toBe('seed');
    expect(fb.trimmed).toBe(2);
    expect(fb.blocks.every((b) => b.day <= 3)).toBe(true);
    expect(fb.blocks).toHaveLength(12);
    expect(totalCost(fb.blocks)).toBeLessThanOrEqual(c.budgetCeiling);
    expect(fb.ok).toBe(true);
  });

  it('still returns blocks when the budget is too tight to fix by cutting', () => {
    const broke: Trip = { ...SEED_TRIP, budgetPerPerson: 40 };
    const c = constraintsFor(broke);
    const pool = buildCandidatePool(SEED_PLACES, c);
    const fb = fallbackToSeed(c, SEED_ITINERARY, pool.all);

    expect(fb.source).toBe('seed');
    expect(fb.ok).toBe(false);
    expect(fb.violations.length).toBeGreaterThan(0);
    // Blocks are not withheld just because the result is imperfect
    expect(fb.blocks.length).toBeGreaterThan(0);
  });

  it('refuses a different city rather than showing the wrong itinerary', () => {
    const kyoto: Trip = { ...SEED_TRIP, cityKey: 'kyoto', destination: 'Kyoto' };
    const c = constraintsFor(kyoto);
    const fb = fallbackToSeed(c, SEED_ITINERARY, []);

    expect(fb.source).toBe('failed');
    expect(fb.blocks).toEqual([]);
    expect(fb.reason).toContain('kyoto');
  });

  it('refuses a trip longer than the seed — days can be cut, not invented', () => {
    const longer: Trip = { ...SEED_TRIP, endDate: '2026-09-20' };
    const c = constraintsFor(longer);
    const fb = fallbackToSeed(c, SEED_ITINERARY, []);

    expect(fb.source).toBe('failed');
    expect(fb.blocks).toEqual([]);
    expect(fb.reason).toContain('day');
  });

  it('comes back through generateItinerary as source "failed", without throwing', async () => {
    const kyoto: Trip = { ...SEED_TRIP, cityKey: 'kyoto', destination: 'Kyoto' };
    const llm = new MockLLMClient({ responses: [{ junk: 1 }, { junk: 2 }] });
    const result = await generateItinerary({ trip: kyoto, preferences: SEED_PREFS }, deps({ llm }));

    expect(result.source).toBe('failed');
    expect(result.ok).toBe(false);
    expect(result.blocks).toEqual([]);
  });

  it('does not launder the seed into looking like an AI answer', async () => {
    const llm = new MockLLMClient({ responses: [{ junk: 1 }, { junk: 2 }] });
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm }),
    );
    expect(result.source).toBe('seed');
    for (const b of result.blocks) {
      expect(b.createdBy).toBe('seed');
      expect(b.reason?.votes ?? null).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// §7 steps 3 and 4 — what actually reaches the model
// ---------------------------------------------------------------------------

describe('generateItinerary — what the prompt is allowed to contain', () => {
  it('keeps places the group excluded out of the candidate list', async () => {
    const llm = new MockLLMClient({ responses: [draftOf(block(1, '10:00', 60, 'dotonbori', 0))] });
    await generateItinerary(
      {
        trip: { ...TRIP, endDate: TRIP.startDate },
        preferences: [pref({ noGo: 'aquarium' })],
      },
      deps({ llm }),
    );

    expect(llm.prompts[0]).not.toContain('kaiyukan');
    expect(llm.prompts[0]).toContain('dotonbori');
  });

  it('keeps places that are closed that day out of the candidate list', async () => {
    // 2026-09-08 is a Tuesday, and the history museum closes on Tuesdays
    const tuesday: Trip = { ...TRIP, startDate: '2026-09-08', endDate: '2026-09-08' };
    const llm = new MockLLMClient({ responses: [draftOf(block(1, '10:00', 60, 'dotonbori', 0))] });
    await generateItinerary({ trip: tuesday, preferences: [pref()] }, deps({ llm }));

    expect(llm.prompts[0]).not.toContain('osaka-museum-history');
    expect(llm.prompts[0]).toContain('osaka-castle');
  });

  it('spells out the hard rules the post-validation will enforce', async () => {
    const llm = new MockLLMClient();
    await generateItinerary({ trip: SEED_TRIP, preferences: SEED_PREFS }, deps({ llm }));
    const prompt = llm.prompts[0] ?? '';

    expect(prompt).toContain('Never invent a place');
    expect(prompt).toContain('must not exceed');
    expect(prompt).toContain('opening hours');
    expect(prompt).toContain('Osaka Castle'); // a must-do, listed as a hard rule
  });

  it('searches on must-dos and interests, and passes the top-k through', async () => {
    const knowledge = new MockKnowledgeRetriever();
    await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ knowledge, knowledgeTopK: 3 }),
    );

    const asked = knowledge.queries.map((q) => q.query);
    expect(asked).toContain('Osaka Castle');
    expect(asked).toContain('history');
    expect(knowledge.queries.every((q) => q.cityKey === 'osaka')).toBe(true);
    expect(knowledge.queries.every((q) => q.k === 3)).toBe(true);
  });

  it('puts the retrieved knowledge in the prompt with its source attached', async () => {
    const llm = new MockLLMClient();
    await generateItinerary({ trip: SEED_TRIP, preferences: SEED_PREFS }, deps({ llm }));
    expect(llm.prompts[0]).toContain('[Wikivoyage / Osaka]');
    expect(llm.prompts[0]).toContain('Do not invent quotes or URLs');
  });

  it('carries the citations out on the result for step 8 to persist', async () => {
    const result = await generateItinerary({ trip: SEED_TRIP, preferences: SEED_PREFS }, deps());
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.every((c) => c.source === 'Wikivoyage / Osaka')).toBe(true);
  });

  it('survives a retriever that throws — taste is optional, the hard rules are not', async () => {
    const knowledge = new MockKnowledgeRetriever();
    knowledge.search = async () => {
      throw new Error('pgvector down');
    };
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ knowledge }),
    );
    expect(result.source).toBe('llm');
    expect(result.citations).toEqual([]);
  });
});

describe('citations on generated blocks', () => {
  it('keeps a citation whose source was actually retrieved', async () => {
    const draft = seedAsDraft();
    const cited: ItineraryDraft = {
      ...draft,
      blocks: draft.blocks.map((b, i) =>
        i === 0
          ? {
              ...b,
              sourceCitation: {
                text: 'the grounds are free',
                source: 'Wikivoyage / Osaka',
                url: null,
              },
            }
          : b,
      ),
    };
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm: new MockLLMClient({ responses: [cited] }) }),
    );
    expect(result.blocks[0]?.sourceCitation?.source).toBe('Wikivoyage / Osaka');
  });

  it('drops a citation naming a source that was never retrieved', async () => {
    const draft = seedAsDraft();
    const faked: ItineraryDraft = {
      ...draft,
      blocks: draft.blocks.map((b, i) =>
        i === 0
          ? {
              ...b,
              sourceCitation: { text: 'trust me', source: 'The Osaka Times', url: null },
            }
          : b,
      ),
    };
    const result = await generateItinerary(
      { trip: SEED_TRIP, preferences: SEED_PREFS },
      deps({ llm: new MockLLMClient({ responses: [faked] }) }),
    );
    // Same principle as an invented placeId: a source we never saw is made up
    expect(result.blocks[0]?.sourceCitation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The exported helpers, on their own
// ---------------------------------------------------------------------------

describe('buildQueries', () => {
  it('puts must-dos before interests and drops duplicates', () => {
    const c = buildConstraints(SEED_TRIP, SEED_PREFS);
    const queries = buildQueries(SEED_PREFS, c);

    expect(queries.slice(0, c.forced.length)).toEqual(c.forced);
    expect(new Set(queries).size).toBe(queries.length);
  });

  it('respects the cap', () => {
    const c = buildConstraints(SEED_TRIP, SEED_PREFS);
    expect(buildQueries(SEED_PREFS, c, 3)).toHaveLength(3);
  });

  it('copes with no preferences at all', () => {
    const c = buildConstraints(TRIP, []);
    expect(buildQueries([], c)).toEqual([]);
  });
});

describe('buildCandidatePool', () => {
  it('indexes by day and unions across the trip', () => {
    const c = buildConstraints(SEED_TRIP, SEED_PREFS);
    const pool = buildCandidatePool(SEED_PLACES, c);

    expect(pool.byDay.size).toBe(5);
    expect(pool.ids.size).toBe(pool.all.length);
    // A place closed on Monday is still a candidate, because the trip has other days
    expect(pool.ids.has('nmao')).toBe(true);
    expect(pool.byDay.get(1)?.some((p) => p.id === 'nmao')).toBe(false);
    expect(pool.byDay.get(4)?.some((p) => p.id === 'nmao')).toBe(true);
  });

  it('holds every place the always-open fixtures rely on', () => {
    const c = buildConstraints(TRIP, [pref()]);
    const pool = buildCandidatePool(SEED_PLACES, c);
    for (const id of ALWAYS_OPEN) expect(pool.ids.has(id)).toBe(true);
  });
});
