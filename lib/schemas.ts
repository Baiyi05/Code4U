/**
 * lib/schemas.ts — the one place every type in this project is defined.
 *
 * Written as Zod schemas with the TypeScript types inferred off them. The LLM's
 * reply has to be checked at runtime anyway (spec §7 step 6 and §8 step 7 both
 * call for it), and once the schema exists the static type comes for free.
 *
 * Naming: camelCase, everywhere. The database columns are snake_case; that
 * conversion belongs at the route-handler boundary, so nothing under lib/ ever
 * sees a snake_case field.
 *
 * Two groups live here:
 *   - Domain types mirroring the §5 tables — Trip, Member, Preference, Place,
 *     Block — plus the Constraints the rule engine folds them into.
 *   - LLM output contracts — ItineraryDraftSchema (§7 step 5) and
 *     ReplanOpsSchema (§8 step 6). Parse the model's reply through these before
 *     anything else touches it.
 *
 * A note on strictness: the object schemas strip unknown keys rather than
 * rejecting them. A model that volunteers one extra field should not burn the
 * single retry §7 step 6 allows.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' */
export const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 'HH:MM' or 'HH:MM:SS' — Postgres time columns come back with the seconds.
 * Deliberately loose about the hour so past-midnight closing times ('25:30')
 * still parse; the 0–47 range check lives in constraints.ts.
 */
export const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** A wall-clock time of day, 00:00–23:59. Stricter than CLOCK_RE; used on LLM output. */
export const WALL_CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const IsoDateSchema = z.string().regex(ISO_DATE_RE, 'expected YYYY-MM-DD');
export const ClockSchema = z.string().regex(CLOCK_RE, 'expected HH:MM or HH:MM:SS');
export const WallClockSchema = z.string().regex(WALL_CLOCK_RE, 'expected HH:MM between 00:00 and 23:59');

export const PaceSchema = z.enum(['chill', 'balanced', 'packed']);
export type Pace = z.infer<typeof PaceSchema>;

export const BudgetBandSchema = z.enum(['low', 'mid', 'high']);
export type BudgetBand = z.infer<typeof BudgetBandSchema>;

/** 0 = Sunday … 6 = Saturday, matching Date#getUTCDay */
export const WeekdaySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
export type Weekday = z.infer<typeof WeekdaySchema>;

export const TimeRangeSchema = z.object({
  open: ClockSchema,
  /** close <= open means it runs past midnight (+24h); '25:30' works too */
  close: ClockSchema,
});
export type TimeRange = z.infer<typeof TimeRangeSchema>;

/**
 * The shape this project assumes for a place's opening hours.
 *
 * For whoever writes scripts/fetch-places.ts: this is the contract. The prefetch
 * has to emit exactly this, camelCase included, or every place silently reads as
 * "hours unknown" and the opening-hours checks stop catching anything.
 */
export const OpeningHoursSchema = z.object({
  /**
   * Weekday '0'–'6' → that day's ranges. A missing key, or an empty array,
   * means closed that day. Keys stay strings because that is how they arrive
   * from jsonb.
   */
  periods: z.record(z.string().regex(/^[0-6]$/, 'expected a weekday 0–6'), z.array(TimeRangeSchema)).optional(),
  /** 'YYYY-MM-DD' → overrides periods, for one-off closures */
  exceptions: z.record(IsoDateSchema, z.array(TimeRangeSchema)).optional(),
  alwaysOpen: z.boolean().optional(),
});
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;

// ---------------------------------------------------------------------------
// Domain types (§5 tables)
// ---------------------------------------------------------------------------

export const TripSchema = z.object({
  id: z.string(),
  /** shows up in the invite link, e.g. 'OSK-4K2' */
  slug: z.string(),
  destination: z.string(),
  /** decides which POI / RAG corpus to use, e.g. 'osaka' */
  cityKey: z.string(),
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  budgetPerPerson: z.number(),
  /**
   * IANA zone, e.g. 'Asia/Tokyo'. Only lib/time.ts reads it, at the route-handler
   * boundary, to turn a real timestamp into the { day, time } the engines use.
   * Optional until the trips table has the column; toTripLocal falls back to a
   * cityKey lookup.
   */
  timezone: z.string().nullish(),
  captainId: z.string().nullish(),
  createdAt: z.string().nullish(),
});
export type Trip = z.infer<typeof TripSchema>;

export const MemberSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  displayName: z.string(),
  isCaptain: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;

export const PreferenceSchema = z.object({
  memberId: z.string(),
  tripId: z.string(),
  budgetBand: BudgetBandSchema.nullable(),
  pace: PaceSchema.nullable(),
  interests: z.array(z.string()).nullable(),
  dietary: z.array(z.string()).nullable(),
  /** the column is text, not text[] — it may hold several items, so it gets split */
  mustDo: z.string().nullable(),
  noGo: z.string().nullable(),
});
export type Preference = z.infer<typeof PreferenceSchema>;

export const PlaceSchema = z.object({
  /** the Google place_id, carried through as-is */
  id: z.string(),
  cityKey: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  district: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  /** null or unparsable = missing data → treated as open all day (§11 fault tolerance) */
  openingHours: OpeningHoursSchema.nullable(),
  estCostPerPerson: z.number().nullable(),
  avgDurationMin: z.number().nullable(),
  indoor: z.boolean(),
  vegFriendly: z.boolean(),
});
export type Place = z.infer<typeof PlaceSchema>;

/** blocks.reason — the three things the UI shows as "why this is here" */
export const BlockReasonSchema = z.object({
  budget: z.string().nullish(),
  votes: z.string().nullish(),
  constraint: z.string().nullish(),
});
export type BlockReason = z.infer<typeof BlockReasonSchema>;

/** blocks.source_citation — where the taste layer's claim came from */
export const SourceCitationSchema = z.object({
  text: z.string(),
  source: z.string(),
  url: z.url().nullish(),
});
export type SourceCitation = z.infer<typeof SourceCitationSchema>;

/** 'seed' marks a block that came from the fallback data, not from this trip's LLM run */
export const BlockOriginSchema = z.enum(['ai', 'captain', 'replan', 'seed']);
export type BlockOrigin = z.infer<typeof BlockOriginSchema>;

export const BlockSchema = z.object({
  id: z.string(),
  tripId: z.string().nullish(),
  /** 1-based day index within the trip */
  day: z.number(),
  startTime: ClockSchema,
  durationMin: z.number(),
  title: z.string(),
  subtitle: z.string().nullish(),
  placeId: z.string().nullable(),
  costPerPerson: z.number(),
  /** re-plan never moves a locked block (§8 step 7) */
  locked: z.boolean(),
  reason: BlockReasonSchema.nullish(),
  sourceCitation: SourceCitationSchema.nullish(),
  createdBy: BlockOriginSchema.nullish(),
});
export type Block = z.infer<typeof BlockSchema>;

// ---------------------------------------------------------------------------
// Rule-engine output
// ---------------------------------------------------------------------------

export const ConstraintsSchema = z.object({
  cityKey: z.string(),
  /**
   * 'YYYY-MM-DD', or '' when the trip's start date was unreadable. Loose on
   * purpose: buildConstraints degrades rather than throwing, so this schema has
   * to accept what it produces.
   */
  startDate: z.string(),
  /** endDate - startDate + 1, never below 1 */
  days: z.number(),
  /** per-person spending ceiling — the LOWEST across all members, never the average */
  budgetCeiling: z.number(),
  blocksPerDay: z.number(),
  /** the resolved pace, handy when writing block.reason */
  pace: PaceSchema,
  /** these three keep the original trimmed text; matching normalizes internally */
  requiredTags: z.array(z.string()),
  forced: z.array(z.string()),
  excluded: z.array(z.string()),
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

export const ViolationCodeSchema = z.enum([
  /** placeId is not in the candidate list — stops the LLM inventing places, §7 step 7 */
  'unknown_place',
  'missing_place',
  'over_budget',
  'overlap',
  'outside_opening_hours',
  'closed_that_day',
  'missing_forced',
  'invalid_day',
  'invalid_time',
  /** the locked blocks alone are over the ceiling — enforceBudget cannot fix it */
  'locked_over_budget',
  /** re-plan: a move landed outside the window the rule layer computed */
  'move_out_of_window',
  /** re-plan: two or more ops targeted the same block, so none of them can be trusted */
  'conflicting_ops',
  /** re-plan: the diff cuts all it can and the trip is still over the ceiling */
  'still_over_budget',
  /** re-plan: an op targeted a block that is locked or already in the past */
  'immovable_block',
  /** re-plan: an op targeted a block id that is not in this itinerary */
  'unknown_block',
  /** re-plan: no usable set of changes could be produced at all */
  'replan_failed',
]);
export type ViolationCode = z.infer<typeof ViolationCodeSchema>;

export const ViolationSchema = z.object({
  code: ViolationCodeSchema,
  /** human-readable, safe to surface in the UI as-is */
  message: z.string(),
  blockId: z.string().optional(),
  day: z.number().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type Violation = z.infer<typeof ViolationSchema>;

export const ValidationResultSchema = z.object({
  ok: z.boolean(),
  violations: z.array(ViolationSchema),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// ---------------------------------------------------------------------------
// L2 Taste — retrieved knowledge (§7 step 4)
// ---------------------------------------------------------------------------

/** One row of what match_knowledge() returns, plus the two columns it does not select. */
export const KnowledgeChunkSchema = z.object({
  chunk: z.string(),
  /** e.g. 'Wikivoyage / Osaka' — this is what ends up in block.sourceCitation.source */
  source: z.string(),
  url: z.url().nullish(),
  district: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  /** 1 - cosine distance; absent when the retriever does not report it */
  similarity: z.number().nullish(),
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

// ---------------------------------------------------------------------------
// LLM output — itinerary generation (§7 step 5)
// ---------------------------------------------------------------------------

/**
 * One block as the model is allowed to emit it.
 *
 * It does not get to invent `id` or `locked` — the database owns those.
 * `placeId` is required and non-empty on purpose: that is the schema half of
 * the anti-hallucination rule. The other half is validateItinerary checking the
 * id against the candidate list that was actually sent to the model, which no
 * schema can do on its own.
 */
export const DraftBlockSchema = z.object({
  day: z.number().int().min(1),
  startTime: WallClockSchema,
  durationMin: z.number().int().min(0),
  title: z.string().min(1),
  subtitle: z.string().nullish(),
  placeId: z.string().min(1, 'every block must point at a candidate place'),
  costPerPerson: z.number().int().min(0),
  reason: BlockReasonSchema.nullish(),
  sourceCitation: SourceCitationSchema.nullish(),
});
export type DraftBlock = z.infer<typeof DraftBlockSchema>;

export const ItineraryDraftSchema = z.object({
  blocks: z.array(DraftBlockSchema).min(1, 'an itinerary with no blocks is not an itinerary'),
  /** one line the UI can show above the plan; optional */
  summary: z.string().nullish(),
});
export type ItineraryDraft = z.infer<typeof ItineraryDraftSchema>;

// ---------------------------------------------------------------------------
// LLM output — re-plan ops (§8 step 6)
// ---------------------------------------------------------------------------

/** §8 step 7: every op carries a reason. No silent changes. */
const NoteSchema = z.string().min(1, 'every op needs a note explaining it');

/** Where a moved block ends up. Omit durationMin to keep the block's own length. */
export const MoveTargetSchema = z.object({
  day: z.number().int().min(1),
  startTime: WallClockSchema,
  durationMin: z.number().int().min(0).nullish(),
});
export type MoveTarget = z.infer<typeof MoveTargetSchema>;

export const ReplanOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('keep'), blockId: z.string().min(1), note: NoteSchema }),
  z.object({
    op: z.literal('move'),
    blockId: z.string().min(1),
    to: MoveTargetSchema,
    note: NoteSchema,
  }),
  z.object({ op: z.literal('remove'), blockId: z.string().min(1), note: NoteSchema }),
  z.object({ op: z.literal('add'), block: DraftBlockSchema, note: NoteSchema }),
]);
export type ReplanOp = z.infer<typeof ReplanOpSchema>;

/**
 * What the model returns from a re-plan.
 *
 * The other half of §8 step 7 — "no op may touch a locked block" — cannot live
 * in a schema, because whether a block is locked is not in the model's reply.
 * replan.ts has to check the blockIds against the day's locked set after this
 * parses, and rerun the whole thing if any op crosses one.
 */
export const ReplanOpsSchema = z.object({
  ops: z.array(ReplanOpSchema).min(1, 'a re-plan with no ops is not a re-plan'),
  /** how far the ops move the per-person total; the server recomputes it, this is a hint */
  budgetDelta: z.number().int().nullish(),
  summary: z.string().nullish(),
});
export type ReplanOps = z.infer<typeof ReplanOpsSchema>;

/** The bare array, matching the replan_diffs.ops column */
export const ReplanOpListSchema = z.array(ReplanOpSchema);
export type ReplanOpList = z.infer<typeof ReplanOpListSchema>;

// ---------------------------------------------------------------------------
// Seed data (§7 step 6 / §11 — the fallback that keeps the demo alive)
// ---------------------------------------------------------------------------

/**
 * The shape of seeds/osaka-trip.json.
 *
 * It carries its own trip and preferences rather than bare blocks, because the
 * only way to prove a fallback itinerary is legal is to derive constraints from
 * it and run validateItinerary. A seed that is not valid against its own inputs
 * is worse than no seed at all.
 */
export const SeedItinerarySchema = z.object({
  trip: TripSchema,
  members: z.array(MemberSchema),
  preferences: z.array(PreferenceSchema),
  blocks: z.array(BlockSchema),
});
export type SeedItinerary = z.infer<typeof SeedItinerarySchema>;

// ---------------------------------------------------------------------------
// Re-plan input and output (§8)
// ---------------------------------------------------------------------------

/**
 * A disruption, as §5's `disruptions` table stores it. Discriminated on `type`
 * so each payload is typed rather than being a bag of unknowns.
 */
export const DisruptionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delay'),
    day: z.number().int().min(1),
    /** how much later the day now starts */
    payload: z.object({ hours: z.number(), note: z.string().nullish() }),
  }),
  z.object({
    type: z.literal('weather'),
    day: z.number().int().min(1),
    payload: z.object({ condition: z.string().nullish() }).nullish(),
  }),
  z.object({
    type: z.literal('closed'),
    day: z.number().int().min(1),
    payload: z.object({ placeId: z.string().min(1), note: z.string().nullish() }),
  }),
  z.object({
    type: z.literal('overbudget'),
    day: z.number().int().min(1),
    /** target defaults to constraints.budgetCeiling */
    payload: z.object({ target: z.number().nullish() }).nullish(),
  }),
]);
export type Disruption = z.infer<typeof DisruptionSchema>;
export type DisruptionType = Disruption['type'];

export const ReplanStatusSchema = z.enum(['pending', 'accepted', 'partial', 'rejected']);
export type ReplanStatus = z.infer<typeof ReplanStatusSchema>;

/**
 * One op, wrapped with what the server worked out about it.
 *
 * costDelta is on the wrapper and not on ReplanOpSchema on purpose: the model
 * returns intent, the server prices it. The frontend sums the costDeltas of the
 * boxes it has ticked to preview a partial acceptance without another round trip.
 */
export const DiffOpSchema = z.object({
  /** stable within one diff, so the frontend can post back a subset */
  id: z.string(),
  op: ReplanOpSchema,
  /** what accepting this one op does to the per-person total: keep 0, move 0, remove -cost, add +cost */
  costDelta: z.number(),
  /** anything questionable about this op that was not bad enough to discard it */
  violations: z.array(ViolationSchema),
});
export type DiffOp = z.infer<typeof DiffOpSchema>;

/** The window the rule layer leaves open for re-scheduling. */
export const TimeWindowSchema = z.object({
  /** the day it applies to, or null when the scope spans days (overbudget) */
  day: z.number().nullable(),
  earliestStart: ClockSchema,
  latestEnd: ClockSchema,
});
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

/** What lands in replan_diffs. §8 step 8: computed and returned, never applied. */
export const ReplanDiffSchema = z.object({
  ops: z.array(DiffOpSchema),
  /** the whole diff applied, per person; the frontend recomputes for a subset */
  budgetDelta: z.number(),
  status: ReplanStatusSchema,
  violations: z.array(ViolationSchema),
});
export type ReplanDiff = z.infer<typeof ReplanDiffSchema>;
