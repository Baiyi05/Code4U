/**
 * lib/generate.ts — the generation pipeline (technical-spec §7).
 *
 * This is orchestration only. Every rule it enforces lives in constraints.ts and
 * every shape it trusts lives in schemas.ts; nothing here re-implements either.
 *
 * Everything external is an injected interface, so the whole of §7 steps 1–7 runs
 * with no network, no Gemini and no Supabase. The real implementations belong to
 * the AI and Database roles; the mocks under __mocks__/ are what the tests use.
 *
 * Step 8 (writing to the database) is deliberately NOT here. generateItinerary
 * returns a result and the route handler persists it.
 *
 * It never throws. §11 is explicit that the fallback chain is what keeps the demo
 * alive, so every failure path ends in a returned GenerateResult.
 */

import {
  buildConstraints,
  enforceBudget,
  filterCandidates,
  totalCost,
  validateItinerary,
} from './constraints';
import { SEED_ITINERARY } from './seed';
import {
  ItineraryDraftSchema,
  type Block,
  type Constraints,
  type ItineraryDraft,
  type KnowledgeChunk,
  type Place,
  type Preference,
  type SeedItinerary,
  type SourceCitation,
  type Trip,
  type Violation,
} from './schemas';

// ---------------------------------------------------------------------------
// Injected boundaries — real implementations are somebody else's job
// ---------------------------------------------------------------------------

/** §7 step 5 — the only thing in the pipeline that talks to Gemini. */
export interface LLMClient {
  /** The parsed JSON the model replied with. Throwing is fine; generateItinerary catches. */
  generate(prompt: string): Promise<unknown>;
}

/** §7 step 3 — L1 Facts, reading the prefetched `places` table. */
export interface PlaceRepository {
  byCity(cityKey: string): Promise<Place[]>;
}

/** §7 step 4 — L2 Taste, one match_knowledge() call per query. */
export interface KnowledgeRetriever {
  search(query: string, cityKey: string, k: number): Promise<KnowledgeChunk[]>;
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface GenerateInput {
  trip: Trip;
  preferences: Preference[];
  /**
   * Blocks the captain has already locked. They are handed to the model as
   * occupied slots, kept verbatim in the result, and never cut by enforceBudget.
   * Omit for a first generation and the behaviour is exactly as if they did not exist.
   */
  lockedBlocks?: Block[];
}

/** How far a hallucinating model is tolerated before the attempt is written off. */
export interface HallucinationLimits {
  /** Fraction of blocks that may be dropped for an unknown placeId. Default 0.2 */
  maxDroppedRatio?: number;
  /** A day left with fewer blocks than this is a broken day. Default 2 */
  minBlocksPerDay?: number;
}

export interface GenerateDeps {
  llm: LLMClient;
  places: PlaceRepository;
  knowledge: KnowledgeRetriever;
  /** Defaults to seeds/osaka-trip.json */
  seed?: SeedItinerary;
  /** Block ids for the generated blocks; deterministic by default so tests stay stable */
  newId?: (index: number) => string;
  /** §7 step 4 says top 4 */
  knowledgeTopK?: number;
  /** Cap on how many retrieval queries one generation fires */
  maxQueries?: number;
  limits?: HallucinationLimits;
}

export type GenerateSource =
  /** the model got it right first time */
  | 'llm'
  /** the model needed the one retry §7 step 6 allows */
  | 'llm-retry'
  /** the model was no use; this is seeds/osaka-trip.json, trimmed to fit */
  | 'seed'
  /** the model was no use AND the seed does not fit this trip — nothing to show */
  | 'failed';

export interface DroppedBlock {
  placeId: string | null;
  title: string;
  day: number;
  reason: 'unknown_place' | 'over_budget';
}

export interface GenerateAttempt {
  /** false for the first call, true for the retry */
  stricter: boolean;
  /** why the reply was rejected, or null if it was accepted */
  error: string | null;
}

export interface GenerateResult {
  ok: boolean;
  source: GenerateSource;
  blocks: Block[];
  constraints: Constraints;
  /** validateItinerary's findings on the returned blocks — reported, never thrown */
  violations: Violation[];
  /** every block that did not make it, and why. Not swallowed: the caller gets to say so */
  dropped: DroppedBlock[];
  /** the chunks that fed the prompt, for the UI and for step 8's source_citation */
  citations: KnowledgeChunk[];
  /** seed fallback only — how many days were cut off the end to fit this trip */
  trimmed: number;
  /** one entry per LLM call, plus a final one if the seed fallback was unusable too */
  attempts: GenerateAttempt[];
}

const DEFAULT_LIMITS: Required<HallucinationLimits> = {
  maxDroppedRatio: 0.2,
  minBlocksPerDay: 2,
};

const DEFAULT_TOP_K = 4;
const DEFAULT_MAX_QUERIES = 8;
const MAX_ATTEMPTS = 2; // the first call plus the one retry §7 step 6 allows

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function defaultNewId(index: number): string {
  return `gen-${String(index + 1).padStart(2, '0')}`;
}

function asList<T>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function costOf(block: Block): number {
  return Number.isFinite(block.costPerPerson) ? block.costPerPerson : 0;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** day, then time of day — the order a human reads an itinerary in */
function byDayThenTime(a: Block, b: Block): number {
  return a.day - b.day || a.startTime.localeCompare(b.startTime);
}

// ---------------------------------------------------------------------------
// §7 step 3 — candidates
// ---------------------------------------------------------------------------

export interface CandidatePool {
  /** what is usable on each day of the trip */
  byDay: Map<number, Place[]>;
  /** every place usable on at least one day, deduped, in first-seen order */
  all: Place[];
  /** ids of `all` — what validateItinerary checks placeId against */
  ids: Set<string>;
}

/**
 * Narrow the city's places down to what this trip can actually use.
 *
 * filterCandidates runs per day because opening hours are per weekday; the union
 * is what the anti-hallucination check compares against, since a block on day 3
 * may legitimately use a place that is closed on day 1.
 */
export function buildCandidatePool(places: readonly Place[], constraints: Constraints): CandidatePool {
  const byDay = new Map<number, Place[]>();
  const all: Place[] = [];
  const ids = new Set<string>();

  const days = Number.isFinite(constraints.days) ? Math.max(1, Math.trunc(constraints.days)) : 1;
  for (let day = 1; day <= days; day += 1) {
    const forDay = filterCandidates(places, constraints, day);
    byDay.set(day, forDay);
    for (const place of forDay) {
      if (ids.has(place.id)) continue;
      ids.add(place.id);
      all.push(place);
    }
  }
  return { byDay, all, ids };
}

// ---------------------------------------------------------------------------
// §7 step 4 — retrieval queries
// ---------------------------------------------------------------------------

/**
 * One query per interest and per must-do, deduped case-insensitively.
 *
 * Interests have to come from the raw preferences: Constraints deliberately does
 * not carry them, because they are a soft signal and never a hard rule.
 */
export function buildQueries(
  preferences: readonly Preference[],
  constraints: Constraints,
  max: number = DEFAULT_MAX_QUERIES,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || out.length >= max) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  // must-dos first: they are hard requirements, so they get the retrieval budget
  for (const item of constraints.forced ?? []) add(item);
  for (const pref of asList(preferences)) {
    for (const interest of asList(pref?.interests)) add(interest);
  }
  return out;
}

async function retrieve(
  queries: readonly string[],
  cityKey: string,
  deps: GenerateDeps,
): Promise<KnowledgeChunk[]> {
  const topK = deps.knowledgeTopK ?? DEFAULT_TOP_K;
  const seen = new Set<string>();
  const out: KnowledgeChunk[] = [];

  for (const query of queries) {
    let chunks: KnowledgeChunk[] = [];
    try {
      chunks = asList(await deps.knowledge.search(query, cityKey, topK));
    } catch {
      // A retrieval miss costs flavour, not correctness — the hard rules do not
      // depend on it. Keep going rather than failing the whole generation.
      continue;
    }
    for (const chunk of chunks) {
      if (!chunk || typeof chunk.chunk !== 'string') continue;
      const key = `${chunk.source}::${chunk.chunk}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(chunk);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// §7 step 5 — the prompt
// ---------------------------------------------------------------------------

export interface PromptContext {
  trip: Trip;
  constraints: Constraints;
  pool: CandidatePool;
  citations: readonly KnowledgeChunk[];
  lockedBlocks: readonly Block[];
  /** budgetCeiling minus what the locked blocks already commit */
  budgetAvailable: number;
}

function describePlace(place: Place): string {
  const bits = [
    `- ${place.id} | ${place.name}`,
    place.category ? `category: ${place.category}` : null,
    place.district ? `district: ${place.district}` : null,
    place.estCostPerPerson !== null ? `about ${place.estCostPerPerson} per person` : null,
    place.avgDurationMin !== null ? `usually ${place.avgDurationMin} min` : null,
    place.indoor ? 'indoor' : null,
    place.vegFriendly ? 'vegetarian-friendly' : null,
  ].filter((b): b is string => typeof b === 'string');
  return bits.join(' | ');
}

/**
 * Build the model's instructions.
 *
 * Exported because it is a pure function worth testing on its own, and because
 * the AI role will want to tune the wording without touching the pipeline.
 *
 * `stricter` is the retry variant from §11: same task, but it leads with what
 * went wrong last time.
 */
export function buildPrompt(
  ctx: PromptContext,
  opts: { stricter?: boolean; previousErrors?: readonly string[] } = {},
): string {
  const { constraints: c, pool, citations, lockedBlocks, budgetAvailable } = ctx;
  const sections: string[] = [];

  if (opts.stricter) {
    const errors = asList(opts.previousErrors);
    sections.push(
      [
        'YOUR PREVIOUS REPLY WAS REJECTED. Read the rules again before answering.',
        ...(errors.length > 0 ? errors.map((e) => `  - ${e}`) : ['  - it did not match the required JSON shape']),
        'Return JSON and nothing else. No prose, no markdown fences.',
      ].join('\n'),
    );
  }

  sections.push(
    `You are planning a group trip to ${ctx.trip.destination}, day 1 starting ${c.startDate}.`,
  );

  sections.push(
    [
      'HARD RULES. A reply that breaks any of these is thrown away:',
      `1. Every block's placeId must be copied exactly from the CANDIDATE PLACES list below.`,
      '   Never invent a place, and never use an id that is not on the list.',
      `2. The per-person total of costPerPerson across every block you return must not exceed ${budgetAvailable}.`,
      '3. Blocks on the same day must not overlap, and each must sit inside its place’s opening hours.',
      `4. Plan exactly ${c.days} day(s), numbered 1 to ${c.days}, at about ${c.blocksPerDay} blocks per day.`,
      ...(c.forced.length > 0
        ? [`5. Every one of these must appear in a block title: ${c.forced.join(', ')}`]
        : []),
    ].join('\n'),
  );

  const softBits: string[] = [`Group pace: ${c.pace}.`];
  if (c.requiredTags.length > 0) {
    softBits.push(
      `Dietary needs across the group: ${c.requiredTags.join(', ')}. Prefer places that suit them.`,
    );
  }
  if (c.excluded.length > 0) {
    softBits.push(`The group asked to avoid: ${c.excluded.join(', ')}.`);
  }
  sections.push(`PREFERENCES\n${softBits.map((b) => `  ${b}`).join('\n')}`);

  if (lockedBlocks.length > 0) {
    sections.push(
      [
        'ALREADY FIXED. These slots are locked by the group. Do not return them, do not',
        'move them, and do not schedule anything that overlaps them. Plan around them.',
        ...lockedBlocks
          .slice()
          .sort(byDayThenTime)
          .map(
            (b) =>
              `  - day ${b.day} ${b.startTime} for ${b.durationMin} min: ${b.title}` +
              ` (${costOf(b)} per person)`,
          ),
        `  They already commit ${totalCost(lockedBlocks)} of the ${c.budgetCeiling} ceiling,`,
        `  which is why your budget is ${budgetAvailable}.`,
      ].join('\n'),
    );
  }

  const dayLines: string[] = [];
  for (const [day, forDay] of [...pool.byDay.entries()].sort((a, b) => a[0] - b[0])) {
    dayLines.push(`  day ${day}: ${forDay.map((p) => p.id).join(', ') || '(nothing available)'}`);
  }
  sections.push(
    [
      'CANDIDATE PLACES. This is the whole world of options; there is nothing else.',
      ...pool.all.map(describePlace),
      '',
      'Open on each day (a place missing from a day is closed that day):',
      ...dayLines,
    ].join('\n'),
  );

  if (citations.length > 0) {
    sections.push(
      [
        'LOCAL KNOWLEDGE. Use these to write the reason and the sourceCitation.',
        'Only ever cite a source that appears here. Do not invent quotes or URLs.',
        ...citations.map((k) => `  - [${k.source}] ${k.chunk}`),
      ].join('\n'),
    );
  }

  sections.push(
    [
      'REPLY FORMAT. JSON only, matching exactly:',
      '{',
      '  "summary": "one sentence",',
      '  "blocks": [',
      '    {',
      '      "day": 1,',
      '      "startTime": "09:30",',
      '      "durationMin": 120,',
      '      "title": "short, specific",',
      '      "placeId": "an id copied from the candidate list",',
      '      "costPerPerson": 25,',
      '      "reason": { "budget": "...", "constraint": "..." },',
      '      "sourceCitation": { "text": "...", "source": "...", "url": "..." }',
      '    }',
      '  ]',
      '}',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// §7 step 5 → 7 — turning a draft into blocks
// ---------------------------------------------------------------------------

export interface DraftToBlocksOptions {
  tripId: string;
  newId: (index: number) => string;
  /** Sources the retriever actually returned — anything else is a fabricated citation */
  allowedSources: ReadonlySet<string>;
}

function keepCitation(
  citation: SourceCitation | null | undefined,
  allowed: ReadonlySet<string>,
): SourceCitation | null {
  if (!citation || typeof citation.source !== 'string') return null;
  // A citation naming a source we never retrieved is the model making one up.
  // Dropping it is the same principle as dropping an invented placeId.
  return allowed.has(citation.source) ? citation : null;
}

export function draftToBlocks(draft: ItineraryDraft, opts: DraftToBlocksOptions): Block[] {
  return draft.blocks.map((b, index) => ({
    id: opts.newId(index),
    tripId: opts.tripId,
    day: b.day,
    startTime: b.startTime,
    durationMin: b.durationMin,
    title: b.title,
    subtitle: b.subtitle ?? null,
    placeId: b.placeId,
    costPerPerson: b.costPerPerson,
    locked: false,
    reason: b.reason ?? null,
    sourceCitation: keepCitation(b.sourceCitation, opts.allowedSources),
    createdBy: 'ai' as const,
  }));
}

// ---------------------------------------------------------------------------
// §7 step 7 — the anti-hallucination cut
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  kept: Block[];
  dropped: DroppedBlock[];
}

/**
 * Drop any block pointing at a place the model was not offered.
 *
 * This is the enforcement half of §7 step 7. validateItinerary reports the same
 * thing as an `unknown_place` violation; here we act on it, because an itinerary
 * containing a place that does not exist is worse than a shorter one.
 */
export function dropInventedPlaces(
  blocks: readonly Block[],
  candidateIds: ReadonlySet<string>,
): SanitizeResult {
  const kept: Block[] = [];
  const dropped: DroppedBlock[] = [];
  for (const block of blocks) {
    if (typeof block.placeId === 'string' && candidateIds.has(block.placeId)) {
      kept.push(block);
    } else {
      dropped.push({
        placeId: block.placeId ?? null,
        title: block.title,
        day: block.day,
        reason: 'unknown_place',
      });
    }
  }
  return { kept, dropped };
}

/**
 * Is this draft salvageable, or was the model simply not reading the candidate list?
 *
 * Inventing one place is a slip worth recovering from. Inventing a pile of them,
 * or hollowing out a day, means the reply is not worth keeping — escalate to the
 * retry, and past that, to the seed.
 *
 * Only evaluated when something was actually dropped, so a legitimately thin day
 * in an otherwise clean reply is not treated as a hallucination.
 */
export function exceedsHallucinationLimits(
  result: SanitizeResult,
  limits: HallucinationLimits = {},
): string | null {
  const maxDroppedRatio = limits.maxDroppedRatio ?? DEFAULT_LIMITS.maxDroppedRatio;
  const minBlocksPerDay = limits.minBlocksPerDay ?? DEFAULT_LIMITS.minBlocksPerDay;

  if (result.dropped.length === 0) return null;

  const total = result.kept.length + result.dropped.length;
  if (total === 0) return 'the model returned no usable blocks';

  const ratio = result.dropped.length / total;
  if (ratio > maxDroppedRatio) {
    return (
      `${result.dropped.length} of ${total} blocks pointed at places that were not offered ` +
      `(${Math.round(ratio * 100)}%, over the ${Math.round(maxDroppedRatio * 100)}% limit)`
    );
  }

  const perDay = new Map<number, number>();
  for (const block of result.kept) perDay.set(block.day, (perDay.get(block.day) ?? 0) + 1);
  const touchedDays = new Set<number>([
    ...result.kept.map((b) => b.day),
    ...result.dropped.map((d) => d.day),
  ]);
  for (const day of [...touchedDays].sort((a, b) => a - b)) {
    const left = perDay.get(day) ?? 0;
    if (left < minBlocksPerDay) {
      return `day ${day} was left with ${left} block(s) after dropping invented places`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// §7 step 7 — budget
// ---------------------------------------------------------------------------

function applyBudget(blocks: readonly Block[], constraints: Constraints): SanitizeResult {
  const kept = enforceBudget(blocks, constraints);
  const keptIds = new Set(kept.map((b) => b.id));
  const dropped: DroppedBlock[] = blocks
    .filter((b) => !keptIds.has(b.id))
    .map((b) => ({
      placeId: b.placeId ?? null,
      title: b.title,
      day: b.day,
      reason: 'over_budget' as const,
    }));
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// §7 step 6 / §11 — the seed fallback
// ---------------------------------------------------------------------------

export interface SeedFallback {
  ok: boolean;
  source: 'seed' | 'failed';
  blocks: Block[];
  violations: Violation[];
  /** how many days were cut off the end of the seed */
  trimmed: number;
  /** why the seed was unusable, when source is 'failed' */
  reason: string | null;
}

/**
 * Adapt the seed to the trip in hand, or refuse.
 *
 * The seed is only a legitimate answer if it is about the same city and is at
 * least as long as the trip — days can be cut off the end, but they cannot be
 * invented. When it does not fit, saying so beats showing somebody an itinerary
 * for a city they are not going to.
 */
export function fallbackToSeed(
  constraints: Constraints,
  seed: SeedItinerary,
  candidates: readonly Place[],
): SeedFallback {
  const empty = { blocks: [] as Block[], violations: [] as Violation[], trimmed: 0 };

  if (seed.trip.cityKey !== constraints.cityKey) {
    return {
      ...empty,
      ok: false,
      source: 'failed',
      reason: `the seed is for ${seed.trip.cityKey}, this trip is for ${constraints.cityKey}`,
    };
  }

  const seedDays = seed.blocks.reduce((max, b) => Math.max(max, b.day), 0);
  if (seedDays < constraints.days) {
    return {
      ...empty,
      ok: false,
      source: 'failed',
      reason: `the seed covers ${seedDays} day(s) but this trip needs ${constraints.days}`,
    };
  }

  // Trim from the end, then let the real constraints cut it down to budget.
  const trimmedBlocks = seed.blocks.filter((b) => b.day <= constraints.days);
  const blocks = enforceBudget(trimmedBlocks, constraints).slice().sort(byDayThenTime);
  const { violations } = validateItinerary(blocks, constraints, candidates);

  return {
    ok: violations.length === 0,
    source: 'seed',
    blocks,
    violations,
    trimmed: seedDays - constraints.days,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Run §7 steps 1 through 7 and hand back the result. Step 8 is the caller's.
 *
 * The shape is §11's, made concrete: try, retry once with a stricter prompt, and
 * fall back to the seed. Nothing in here throws.
 */
export async function generateItinerary(
  input: GenerateInput,
  deps: GenerateDeps,
): Promise<GenerateResult> {
  // --- step 1 + 2: inputs and the constraint set ---
  const trip = input.trip;
  const preferences = asList(input.preferences);
  const constraints = buildConstraints(trip, preferences);
  const lockedBlocks = asList(input.lockedBlocks).filter((b) => b && typeof b.id === 'string');

  const seed = deps.seed ?? SEED_ITINERARY;
  const newId = deps.newId ?? defaultNewId;
  const attempts: GenerateAttempt[] = [];
  const dropped: DroppedBlock[] = [];
  let citations: KnowledgeChunk[] = [];
  let pool: CandidatePool = { byDay: new Map(), all: [], ids: new Set() };

  const finish = (
    source: GenerateSource,
    blocks: Block[],
    violations: Violation[],
    trimmed = 0,
  ): GenerateResult => ({
    ok: violations.length === 0 && blocks.length > 0,
    source,
    blocks,
    constraints,
    violations,
    dropped,
    citations,
    trimmed,
    attempts,
  });

  const toSeed = (): GenerateResult => {
    try {
      const fb = fallbackToSeed(constraints, seed, pool.all);
      if (fb.reason) attempts.push({ stricter: true, error: fb.reason });
      return {
        ...finish(fb.source, fb.blocks, fb.violations, fb.trimmed),
        ok: fb.ok && fb.source === 'seed',
      };
    } catch (error) {
      // A broken seed must not take the request down with it.
      attempts.push({ stricter: true, error: `seed unusable: ${messageOf(error)}` });
      return { ...finish('failed', [], []), ok: false };
    }
  };

  try {
    // --- step 3: candidates, per day ---
    const places = asList(await deps.places.byCity(constraints.cityKey));
    pool = buildCandidatePool(places, constraints);

    // A locked block already occupies its place; offering it again invites a duplicate.
    const lockedPlaceIds = new Set(
      lockedBlocks.map((b) => b.placeId).filter((id): id is string => typeof id === 'string'),
    );
    const offered: CandidatePool = {
      byDay: new Map(
        [...pool.byDay].map(([day, list]) => [day, list.filter((p) => !lockedPlaceIds.has(p.id))]),
      ),
      all: pool.all.filter((p) => !lockedPlaceIds.has(p.id)),
      ids: pool.ids,
    };

    // --- step 4: taste ---
    citations = await retrieve(buildQueries(preferences, constraints, deps.maxQueries), constraints.cityKey, deps);
    const allowedSources = new Set(citations.map((c) => c.source));

    // What the model is allowed to spend, once the locked blocks have taken their share.
    const lockedCost = totalCost(lockedBlocks);
    const budgetAvailable = Math.max(0, constraints.budgetCeiling - lockedCost);

    const ctx: PromptContext = {
      trip,
      constraints,
      pool: offered,
      citations,
      lockedBlocks,
      budgetAvailable,
    };

    // --- steps 5 + 6: call, validate the shape, retry once ---
    let previousErrors: string[] = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const stricter = attempt > 0;
      const prompt = buildPrompt(ctx, { stricter, previousErrors });

      let raw: unknown;
      try {
        raw = await deps.llm.generate(prompt);
      } catch (error) {
        const message = `the model call failed: ${messageOf(error)}`;
        attempts.push({ stricter, error: message });
        previousErrors = [message];
        continue;
      }

      const parsed = ItineraryDraftSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
        attempts.push({ stricter, error: `the reply did not match the schema (${issues.join('; ')})` });
        previousErrors = issues;
        continue;
      }

      // --- step 7, first half: no invented places ---
      const blocks = draftToBlocks(parsed.data, { tripId: trip.id, newId, allowedSources });
      const sanitized = dropInventedPlaces(blocks, pool.ids);
      const tooFarGone = exceedsHallucinationLimits(sanitized, deps.limits);
      if (tooFarGone !== null) {
        attempts.push({ stricter, error: tooFarGone });
        previousErrors = [
          tooFarGone,
          'Use only the placeId values from the CANDIDATE PLACES list. Copy them exactly.',
        ];
        continue;
      }

      attempts.push({ stricter, error: null });
      dropped.push(...sanitized.dropped);

      // --- step 7, second half: locked blocks back in, then budget ---
      const merged = [...lockedBlocks, ...sanitized.kept].sort(byDayThenTime);
      const budgeted = applyBudget(merged, constraints);
      dropped.push(...budgeted.dropped);

      const { violations } = validateItinerary(budgeted.kept, constraints, pool.all);
      return finish(stricter ? 'llm-retry' : 'llm', budgeted.kept, violations);
    }

    // Both attempts spent.
    return toSeed();
  } catch (error) {
    // §11: anything unexpected — a repository that throws, a malformed trip —
    // still has to come back as a result, not an exception.
    attempts.push({ stricter: attempts.length > 0, error: messageOf(error) });
    return toSeed();
  }
}
