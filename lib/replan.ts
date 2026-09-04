/**
 * lib/replan.ts — the re-plan engine (technical-spec §8).
 *
 * Two entry points, and the split between them is the whole design:
 *
 *   replan()    computes a diff. It reads. It never writes, never mutates the
 *               blocks it was handed, and never applies anything. §8 step 8.
 *   applyDiff() takes the ops the user actually ticked and applies those only.
 *
 * The hard rule is §8 step 7: if any op touches a block that cannot move —
 * locked, or already in the past — the entire batch is thrown away and the one
 * retry is spent. Not filtered, discarded. A model that ignored the immovable
 * set was not reading its instructions, so its judgement on the other blocks is
 * not worth keeping either.
 *
 * Time comes in through input.now as { day, time }. Nothing here reads a clock
 * or knows what a timezone is; lib/time.ts does that conversion at the boundary.
 *
 * Nothing throws. A failed re-plan is an empty op list plus violations.
 */

import { buildConstraints, validateItinerary } from './constraints';
import { buildCandidatePool, type GenerateAttempt, type GenerateDeps } from './generate';
import {
  ReplanOpsSchema,
  type Block,
  type Constraints,
  type DiffOp,
  type Disruption,
  type DisruptionType,
  type KnowledgeChunk,
  type Place,
  type Preference,
  type ReplanOp,
  type TimeWindow,
  type Trip,
  type Violation,
  type ViolationCode,
} from './schemas';

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

/** Where we are in the trip. Injected, never read from the system clock. */
export interface TripNow {
  /** 1-based day index */
  day: number;
  /** 'HH:MM' */
  time: string;
}

export interface ReplanInput {
  trip: Trip;
  preferences: Preference[];
  /** the whole itinerary, not just the affected day — overbudget needs all of it */
  blocks: Block[];
  disruption: Disruption;
  now: TripNow;
}

export type ReplanSource = 'llm' | 'llm-retry' | 'failed';

export interface ReplanResult {
  ops: DiffOp[];
  /** the whole diff applied, per person */
  budgetDelta: number;
  status: 'pending';
  violations: Violation[];
  source: ReplanSource;
  attempts: GenerateAttempt[];
  citations: KnowledgeChunk[];
  /** what the rule layer left open */
  window: TimeWindow;
  /** block ids that could not be touched, so the UI can grey them out */
  immovable: string[];
  /** block ids the model was allowed to change */
  movable: string[];
}

export interface ApplyDiffOptions {
  /** ids for blocks introduced by an `add` op */
  newId?: (index: number) => string;
  tripId?: string;
  /**
   * Blocks that must not be touched however the accepted list is spelled.
   * Defaults to every locked block. The accepted list arrives from a browser,
   * so this is checked here too rather than trusted.
   */
  immovableIds?: ReadonlySet<string>;
}

export interface ApplyDiffResult {
  blocks: Block[];
  /** per person, computed from the blocks rather than trusted from the ops */
  budgetDelta: number;
  /** ops that were refused, and why */
  violations: Violation[];
}

/** §8: at most this many ops in an overbudget diff, so the screen stays readable */
export const MAX_OVERBUDGET_OPS = 6;

const DAY_END = '23:59';
const MAX_ATTEMPTS = 2;
const DEFAULT_TOP_K = 4;
const MAX_QUERIES = 6;
const MAX_CANDIDATES = 24;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asList<T>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function costOf(block: Block): number {
  return Number.isFinite(block.costPerPerson) ? block.costPerPerson : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CLOCK = /^(\d{1,2}):(\d{2})/;

/** 'HH:MM' → minutes past midnight; null when unreadable */
export function minutesOf(time: unknown): number | null {
  if (typeof time !== 'string') return null;
  const m = CLOCK.exec(time.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 47 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function clockOf(totalMinutes: number): string {
  const capped = Math.max(0, Math.min(totalMinutes, 24 * 60 - 1));
  return `${String(Math.floor(capped / 60)).padStart(2, '0')}:${String(capped % 60).padStart(2, '0')}`;
}

function byDayThenTime(a: Block, b: Block): number {
  return a.day - b.day || a.startTime.localeCompare(b.startTime);
}

function violation(code: ViolationCode, message: string, extra: Partial<Violation> = {}): Violation {
  return { code, message, ...extra };
}

// ---------------------------------------------------------------------------
// §8 step 2 — the two piles
// ---------------------------------------------------------------------------

export interface Movability {
  movable: Block[];
  immovable: Block[];
}

/** Has this block already started, relative to where we are in the trip? */
export function hasPassed(block: Block, now: TripNow): boolean {
  if (!Number.isFinite(block.day) || !Number.isFinite(now?.day)) return false;
  if (block.day < now.day) return true;
  if (block.day > now.day) return false;
  const start = minutesOf(block.startTime);
  const cutoff = minutesOf(now.time);
  if (start === null || cutoff === null) return false;
  return start < cutoff;
}

/**
 * Split the blocks in scope into what may change and what may not.
 *
 * §8 step 2 puts locked blocks and past blocks in the same pile, and §8 step 7's
 * hard check applies to that whole pile — the point is that you cannot change
 * what has already happened any more than you can change what someone locked.
 *
 * `scopeDays` is null for a trip-wide scope (overbudget) or a single day otherwise.
 */
export function splitByMovability(
  blocks: readonly Block[],
  now: TripNow,
  scopeDay: number | null,
): Movability {
  const movable: Block[] = [];
  const immovable: Block[] = [];

  for (const block of asList(blocks)) {
    if (!block || typeof block.id !== 'string') continue;
    const inScope = scopeDay === null ? block.day >= now.day : block.day === scopeDay;
    if (!inScope) continue;
    if (block.locked === true || hasPassed(block, now)) immovable.push(block);
    else movable.push(block);
  }
  return {
    movable: movable.sort(byDayThenTime),
    immovable: immovable.sort(byDayThenTime),
  };
}

// ---------------------------------------------------------------------------
// §8 step 3 — the rule layer
// ---------------------------------------------------------------------------

export interface RuleLayerContext {
  disruption: Disruption;
  constraints: Constraints;
  now: TripNow;
  /** every block in the trip, for the trip-wide budget arithmetic */
  allBlocks: readonly Block[];
  movable: readonly Block[];
  immovable: readonly Block[];
  candidates: readonly Place[];
}

export interface RuleLayerOutput {
  window: TimeWindow;
  /** what the model may pick replacements from, after the type's own filtering */
  candidates: Place[];
  /** the sentence the prompt leads with */
  goal: string;
  /** overbudget only: how much per person has to come off. 0 otherwise */
  shortfall: number;
  /** overbudget only: cap on how many ops the diff may carry */
  maxOps: number | null;
}

/** Which days a disruption is allowed to touch. null means every day from now on. */
export function scopeDayFor(type: DisruptionType, disruptionDay: number): number | null {
  // §8 step 2 is really "you cannot change what already happened", not "only today".
  // delay, weather and closed are about one day's schedule. Going over budget is
  // about the trip, so its scope is every day still ahead.
  return type === 'overbudget' ? null : disruptionDay;
}

export function ruleLayer(ctx: RuleLayerContext): RuleLayerOutput {
  const { disruption, now, constraints } = ctx;
  const day = disruption.day;
  const nowMinutes = now.day === day ? (minutesOf(now.time) ?? 0) : 0;

  const earliestMovable = ctx.movable.reduce<number | null>((min, b) => {
    const start = minutesOf(b.startTime);
    if (start === null) return min;
    return min === null ? start : Math.min(min, start);
  }, null);

  const baseStart = Math.max(nowMinutes, earliestMovable ?? nowMinutes);
  let window: TimeWindow = { day, earliestStart: clockOf(baseStart), latestEnd: DAY_END };
  let candidates = [...ctx.candidates];
  let goal = '';
  let shortfall = 0;
  let maxOps: number | null = null;

  switch (disruption.type) {
    case 'delay': {
      const hours = Number.isFinite(disruption.payload?.hours) ? disruption.payload.hours : 0;
      const shifted = baseStart + Math.round(hours * 60);
      window = { day, earliestStart: clockOf(shifted), latestEnd: DAY_END };
      goal =
        `Day ${day} starts ${hours} hour(s) later than planned. Nothing may begin before ` +
        `${window.earliestStart}. Move what still fits, drop what does not.`;
      break;
    }

    case 'weather': {
      // §8 step 3: shut out everything that is not indoors.
      candidates = candidates.filter((p) => p.indoor === true);
      const condition = disruption.payload?.condition ?? 'bad weather';
      goal =
        `Day ${day} is affected by ${condition}. Every replacement must be indoors; ` +
        `the candidate list below has already had outdoor places removed.`;
      break;
    }

    case 'closed': {
      const closedId = disruption.payload.placeId;
      candidates = candidates.filter((p) => p.id !== closedId);
      goal =
        `The place ${closedId} is closed on day ${day}. Replace or remove every block ` +
        `that uses it. It is not in the candidate list.`;
      break;
    }

    case 'overbudget': {
      // The total is the whole trip's, not the day's: budgetCeiling is a per-person
      // trip figure in §7 and stays one here. No daily allowance is invented.
      const target = Number.isFinite(disruption.payload?.target)
        ? Number(disruption.payload?.target)
        : constraints.budgetCeiling;
      const total = ctx.allBlocks.reduce((sum, b) => sum + costOf(b), 0);
      shortfall = Math.max(0, total - target);
      maxOps = MAX_OVERBUDGET_OPS;
      // Any day from here on is fair game, so the window is not pinned to one day.
      window = { day: null, earliestStart: clockOf(nowMinutes), latestEnd: DAY_END };
      goal =
        `The trip costs ${total} per person against a ceiling of ${target}: ` +
        `${shortfall} has to come off. The changeable blocks are listed most expensive ` +
        `first — work down that list. Return at most ${MAX_OVERBUDGET_OPS} ops. ` +
        `Locked blocks and blocks that have already happened are not available at any price.`;
      break;
    }
  }

  return { window, candidates: candidates.slice(0, MAX_CANDIDATES), goal, shortfall, maxOps };
}

// ---------------------------------------------------------------------------
// §8 step 4 — replacement candidates
// ---------------------------------------------------------------------------

/**
 * Order the candidates the way §8 step 4 asks: same district as the blocks being
 * replaced first, and indoor first when the weather is the problem.
 */
export function rankCandidates(
  candidates: readonly Place[],
  affected: readonly Block[],
  places: ReadonlyMap<string, Place>,
  preferIndoor: boolean,
): Place[] {
  const districts = new Set(
    affected
      .map((b) => (b.placeId ? places.get(b.placeId)?.district : null))
      .filter((d): d is string => typeof d === 'string' && d.length > 0),
  );

  return [...candidates].sort((a, b) => {
    const sameDistrict = Number(districts.has(b.district ?? '')) - Number(districts.has(a.district ?? ''));
    if (sameDistrict !== 0) return sameDistrict;
    if (preferIndoor) {
      const indoor = Number(b.indoor) - Number(a.indoor);
      if (indoor !== 0) return indoor;
    }
    return (a.estCostPerPerson ?? 0) - (b.estCostPerPerson ?? 0);
  });
}

// ---------------------------------------------------------------------------
// §8 step 7 — validating the ops
// ---------------------------------------------------------------------------

/** The blockId an op targets, or null for `add`. */
export function targetOf(op: ReplanOp): string | null {
  return op.op === 'add' ? null : op.blockId;
}

export interface CheckContext {
  movableIds: ReadonlySet<string>;
  immovableIds: ReadonlySet<string>;
  knownIds: ReadonlySet<string>;
  candidateIds: ReadonlySet<string>;
  window: TimeWindow;
  now: TripNow;
}

export interface CheckResult {
  /** non-null means the whole batch is void and the retry gets spent */
  fatal: string | null;
  /** ops that survived, in the model's own order */
  kept: ReplanOp[];
  /** ops that were thrown out individually; they never reach the caller */
  violations: Violation[];
}

function movesOutOfWindow(op: ReplanOp, window: TimeWindow, now: TripNow): string | null {
  if (op.op !== 'move') return null;
  const target = minutesOf(op.to.startTime);
  if (target === null) return `"${op.to.startTime}" is not a time`;

  if (op.to.day < now.day) return `day ${op.to.day} has already passed`;
  if (window.day !== null && op.to.day !== window.day) {
    return `day ${op.to.day} is outside day ${window.day}, which is the only day in scope`;
  }

  const earliest = minutesOf(window.earliestStart) ?? 0;
  const latest = minutesOf(window.latestEnd) ?? 24 * 60 - 1;
  const appliesToDay = window.day !== null || op.to.day === now.day;
  if (appliesToDay && target < earliest) {
    return `${op.to.startTime} is before ${window.earliestStart}, the earliest the day can now start`;
  }
  const duration = Number.isFinite(op.to.durationMin) ? Number(op.to.durationMin ?? 0) : 0;
  if (target + duration > latest) {
    return `${op.to.startTime} plus ${duration} min runs past ${window.latestEnd}`;
  }
  return null;
}

/**
 * The §8 step 7 checks, in two tiers.
 *
 * Fatal, void the whole batch:
 *   - any op touching a locked or already-past block
 *   - an `add` pointing at a place that was never offered
 * Both mean the model ignored what it was told, so nothing it returned is trusted.
 *
 * Discarded individually, reported, batch survives:
 *   - a move landing outside the rule layer's window
 *   - two or more ops on the same block. All of them go: with contradictory
 *     instructions there is no way to tell which one the model meant, and
 *     picking the first or the last would be a guess.
 *
 * Discarded ops do not appear in the returned diff at all, so applyDiff cannot
 * apply them even if a client asks for them.
 */
export function checkOps(ops: readonly ReplanOp[], ctx: CheckContext): CheckResult {
  const violations: Violation[] = [];

  // --- tier 1: anything that voids the batch ---
  for (const op of ops) {
    const target = targetOf(op);
    if (target !== null && ctx.immovableIds.has(target)) {
      return {
        fatal:
          `op "${op.op}" targets block ${target}, which is locked or already past. ` +
          `Immovable blocks may not be touched at all.`,
        kept: [],
        violations: [],
      };
    }
    if (op.op === 'add' && !ctx.candidateIds.has(op.block.placeId)) {
      return {
        fatal: `an "add" op used placeId ${op.block.placeId}, which was not in the candidate list`,
        kept: [],
        violations: [],
      };
    }
  }

  // --- tier 2: ops discarded on their own ---
  const counts = new Map<string, number>();
  for (const op of ops) {
    const target = targetOf(op);
    if (target !== null) counts.set(target, (counts.get(target) ?? 0) + 1);
  }

  const kept: ReplanOp[] = [];
  const reportedConflicts = new Set<string>();

  for (const op of ops) {
    const target = targetOf(op);

    if (target !== null && (counts.get(target) ?? 0) > 1) {
      if (!reportedConflicts.has(target)) {
        reportedConflicts.add(target);
        violations.push(
          violation(
            'conflicting_ops',
            `${counts.get(target)} ops all target block ${target}. None was kept — with ` +
              `contradictory instructions there is no way to tell which was meant.`,
            { blockId: target, detail: { count: counts.get(target) } },
          ),
        );
      }
      continue;
    }

    if (target !== null && !ctx.knownIds.has(target)) {
      violations.push(
        violation('unknown_block', `op "${op.op}" targets block ${target}, which is not in this trip`, {
          blockId: target,
        }),
      );
      continue;
    }

    const outOfWindow = movesOutOfWindow(op, ctx.window, ctx.now);
    if (outOfWindow !== null) {
      violations.push(
        violation('move_out_of_window', `Block ${target} cannot move there: ${outOfWindow}`, {
          blockId: target ?? undefined,
          detail: { window: ctx.window },
        }),
      );
      continue;
    }

    kept.push(op);
  }

  return { fatal: null, kept, violations };
}

// ---------------------------------------------------------------------------
// Pricing the ops
// ---------------------------------------------------------------------------

/** What accepting this one op does to the per-person total. */
export function costDeltaOf(op: ReplanOp, blocks: ReadonlyMap<string, Block>): number {
  switch (op.op) {
    case 'keep':
      return 0;
    case 'move':
      // A move changes when, not what: the cost travels with the block.
      return 0;
    case 'remove': {
      const block = blocks.get(op.blockId);
      return block ? -costOf(block) : 0;
    }
    case 'add':
      return Number.isFinite(op.block.costPerPerson) ? op.block.costPerPerson : 0;
  }
}

function toDiffOps(ops: readonly ReplanOp[], blocks: ReadonlyMap<string, Block>): DiffOp[] {
  return ops.map((op, index) => ({
    id: `op-${String(index + 1).padStart(2, '0')}`,
    op,
    costDelta: costDeltaOf(op, blocks),
    violations: [],
  }));
}

// ---------------------------------------------------------------------------
// §8 step 6 — the prompt
// ---------------------------------------------------------------------------

export interface ReplanPromptContext {
  trip: Trip;
  constraints: Constraints;
  disruption: Disruption;
  now: TripNow;
  rules: RuleLayerOutput;
  movable: readonly Block[];
  immovable: readonly Block[];
  candidates: readonly Place[];
  citations: readonly KnowledgeChunk[];
}

function describeBlock(b: Block): string {
  return (
    `  - ${b.id} | day ${b.day} ${b.startTime} for ${b.durationMin} min | ${b.title}` +
    ` | ${costOf(b)} per person | placeId ${b.placeId ?? 'none'}`
  );
}

export function buildReplanPrompt(
  ctx: ReplanPromptContext,
  opts: { stricter?: boolean; previousErrors?: readonly string[] } = {},
): string {
  const sections: string[] = [];
  const { rules } = ctx;

  if (opts.stricter) {
    const errors = asList(opts.previousErrors);
    sections.push(
      [
        'YOUR PREVIOUS REPLY WAS REJECTED IN FULL. Read the rules again.',
        ...(errors.length > 0 ? errors.map((e) => `  - ${e}`) : ['  - it did not match the required shape']),
        'Return JSON and nothing else.',
      ].join('\n'),
    );
  }

  sections.push(`Something has gone wrong with a trip to ${ctx.trip.destination}. ${rules.goal}`);

  sections.push(
    [
      'HARD RULES. Breaking any of these throws away your entire reply, not just one op:',
      '1. Never emit an op that touches a block in the CANNOT CHANGE list. Not to move it,',
      '   not to remove it, not even to keep it.',
      '2. An "add" op must use a placeId copied exactly from the CANDIDATE PLACES list.',
      '3. Every op needs a note saying why. An op without a reason is not acceptable.',
      ...(rules.maxOps !== null ? [`4. Return at most ${rules.maxOps} ops.`] : []),
    ].join('\n'),
  );

  sections.push(
    [
      `CANNOT CHANGE (locked, or already happened — it is now day ${ctx.now.day}, ${ctx.now.time}):`,
      ...(ctx.immovable.length > 0 ? ctx.immovable.map(describeBlock) : ['  (none)']),
    ].join('\n'),
  );

  sections.push(
    [
      'YOU MAY CHANGE THESE:',
      ...(ctx.movable.length > 0 ? ctx.movable.map(describeBlock) : ['  (none)']),
    ].join('\n'),
  );

  sections.push(
    [
      `TIME WINDOW: ${rules.window.earliestStart} to ${rules.window.latestEnd}` +
        (rules.window.day !== null ? ` on day ${rules.window.day}.` : ', on any day still ahead.'),
      'A move outside it will be thrown out.',
    ].join('\n'),
  );

  sections.push(
    [
      'CANDIDATE PLACES for any replacement. There is nothing else available.',
      ...(ctx.candidates.length > 0
        ? ctx.candidates.map(
            (p) =>
              `  - ${p.id} | ${p.name}` +
              (p.category ? ` | ${p.category}` : '') +
              (p.district ? ` | ${p.district}` : '') +
              (p.estCostPerPerson !== null ? ` | about ${p.estCostPerPerson}` : '') +
              (p.indoor ? ' | indoor' : ''),
          )
        : ['  (none available)']),
    ].join('\n'),
  );

  if (ctx.citations.length > 0) {
    sections.push(
      [
        'LOCAL KNOWLEDGE, for writing the notes. Cite only what appears here.',
        ...ctx.citations.map((k) => `  - [${k.source}] ${k.chunk}`),
      ].join('\n'),
    );
  }

  sections.push(
    [
      'REPLY FORMAT. JSON only:',
      '{',
      '  "ops": [',
      '    { "op": "keep",   "blockId": "...", "note": "why it stays" },',
      '    { "op": "move",   "blockId": "...", "to": { "day": 2, "startTime": "14:00" }, "note": "why" },',
      '    { "op": "remove", "blockId": "...", "note": "why" },',
      '    { "op": "add",    "block": { "day": 2, "startTime": "15:00", "durationMin": 90,',
      '                                 "title": "...", "placeId": "...", "costPerPerson": 0 },',
      '      "note": "why" }',
      '  ]',
      '}',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// replan — §8 steps 1 to 8
// ---------------------------------------------------------------------------

export async function replan(input: ReplanInput, deps: GenerateDeps): Promise<ReplanResult> {
  const trip = input.trip;
  const allBlocks = asList(input.blocks);
  const disruption = input.disruption;
  const now = input.now;
  const constraints = buildConstraints(trip, asList(input.preferences));

  const attempts: GenerateAttempt[] = [];
  const violations: Violation[] = [];
  let citations: KnowledgeChunk[] = [];

  const scopeDay = scopeDayFor(disruption.type, disruption.day);
  const { movable, immovable } = splitByMovability(allBlocks, now, scopeDay);

  // Overbudget works down from the most expensive, so present them that way.
  const ordered =
    disruption.type === 'overbudget' ? [...movable].sort((a, b) => costOf(b) - costOf(a)) : movable;

  let window: TimeWindow = { day: scopeDay, earliestStart: now.time, latestEnd: DAY_END };

  const fail = (source: ReplanSource): ReplanResult => ({
    ops: [],
    budgetDelta: 0,
    status: 'pending',
    violations,
    source,
    attempts,
    citations,
    window,
    immovable: immovable.map((b) => b.id),
    movable: ordered.map((b) => b.id),
  });

  try {
    // --- steps 3 and 4: rules, then candidates ---
    const places = asList(await deps.places.byCity(constraints.cityKey));
    const pool = buildCandidatePool(places, constraints);
    const placesById = new Map(places.map((p) => [p.id, p]));

    // A place a block already uses is not a replacement for it.
    const inUse = new Set(
      allBlocks.map((b) => b.placeId).filter((id): id is string => typeof id === 'string'),
    );
    const dayPool = scopeDay !== null ? (pool.byDay.get(scopeDay) ?? pool.all) : pool.all;

    const rules = ruleLayer({
      disruption,
      constraints,
      now,
      allBlocks,
      movable: ordered,
      immovable,
      candidates: rankCandidates(
        dayPool.filter((p) => !inUse.has(p.id)),
        ordered,
        placesById,
        disruption.type === 'weather',
      ),
    });
    window = rules.window;

    // --- step 5: taste ---
    citations = await retrieveFor(ordered, placesById, constraints.cityKey, deps);

    const promptCtx: ReplanPromptContext = {
      trip,
      constraints,
      disruption,
      now,
      rules,
      movable: ordered,
      immovable,
      candidates: rules.candidates,
      citations,
    };

    const knownIds = new Set(allBlocks.map((b) => b.id));
    const movableIds = new Set(ordered.map((b) => b.id));
    // Every locked or past block in the trip is immovable, not just those in scope.
    const immovableIds = new Set(
      allBlocks.filter((b) => b.locked === true || hasPassed(b, now)).map((b) => b.id),
    );
    const candidateIds = new Set(rules.candidates.map((p) => p.id));
    const blocksById = new Map(allBlocks.map((b) => [b.id, b]));

    let previousErrors: string[] = [];

    // --- steps 6 and 7 ---
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const stricter = attempt > 0;
      const prompt = buildReplanPrompt(promptCtx, { stricter, previousErrors });

      let raw: unknown;
      try {
        raw = await deps.llm.generate(prompt);
      } catch (error) {
        const message = `the model call failed: ${messageOf(error)}`;
        attempts.push({ stricter, error: message });
        previousErrors = [message];
        continue;
      }

      // The schema is what enforces "every op needs a note": note is min(1), so a
      // missing or empty one fails here and costs the attempt.
      const parsed = ReplanOpsSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
        attempts.push({ stricter, error: `the reply did not match the schema (${issues.join('; ')})` });
        previousErrors = issues;
        continue;
      }

      const checked = checkOps(parsed.data.ops, {
        movableIds,
        immovableIds,
        knownIds,
        candidateIds,
        window: rules.window,
        now,
      });

      if (checked.fatal !== null) {
        attempts.push({ stricter, error: checked.fatal });
        previousErrors = [
          checked.fatal,
          'Every op you return must target a block from the "YOU MAY CHANGE THESE" list.',
        ];
        continue;
      }

      let kept = checked.kept;
      if (rules.maxOps !== null && kept.length > rules.maxOps) {
        kept = kept.slice(0, rules.maxOps);
        violations.push(
          violation(
            'still_over_budget',
            `The model returned ${checked.kept.length} ops; only the first ${rules.maxOps} are ` +
              `shown, so the diff stays readable.`,
            { detail: { returned: checked.kept.length, kept: rules.maxOps } },
          ),
        );
      }

      // A delay, a closure or a storm always needs *something* doing. An empty op
      // list means the model did not engage with the problem.
      if (kept.length === 0 && disruption.type !== 'overbudget') {
        const message = `the model returned no usable ops for a ${disruption.type} disruption`;
        attempts.push({ stricter, error: message });
        previousErrors = [message, ...checked.violations.map((v) => v.message)];
        continue;
      }

      attempts.push({ stricter, error: null });
      violations.push(...checked.violations);

      const ops = toDiffOps(kept, blocksById);
      const budgetDelta = ops.reduce((sum, o) => sum + o.costDelta, 0);

      if (rules.shortfall > 0) {
        const stillOver = rules.shortfall + budgetDelta; // budgetDelta is negative when cutting
        if (stillOver > 0) {
          violations.push(
            violation(
              'still_over_budget',
              `These ops save ${-budgetDelta} per person, leaving ${stillOver} still over the ceiling. ` +
                `Locked blocks and blocks already past were not touched to close the gap.`,
              { detail: { shortfall: rules.shortfall, saved: -budgetDelta, remaining: stillOver } },
            ),
          );
        }
      }

      return {
        ops,
        budgetDelta,
        status: 'pending',
        violations,
        source: stricter ? 'llm-retry' : 'llm',
        attempts,
        citations,
        window: rules.window,
        immovable: immovable.map((b) => b.id),
        movable: ordered.map((b) => b.id),
      };
    }

    violations.push(
      violation(
        'replan_failed',
        `The model could not produce a usable set of changes in ${MAX_ATTEMPTS} attempts. ` +
          `Nothing has been changed.`,
        { detail: { attempts: attempts.map((a) => a.error) } },
      ),
    );
    return fail('failed');
  } catch (error) {
    attempts.push({ stricter: attempts.length > 0, error: messageOf(error) });
    violations.push(violation('replan_failed', `The re-plan could not run: ${messageOf(error)}`));
    return fail('failed');
  }
}

async function retrieveFor(
  blocks: readonly Block[],
  places: ReadonlyMap<string, Place>,
  cityKey: string,
  deps: GenerateDeps,
): Promise<KnowledgeChunk[]> {
  const topK = deps.knowledgeTopK ?? DEFAULT_TOP_K;
  const queries: string[] = [];
  const seenQuery = new Set<string>();

  for (const block of blocks) {
    const place = block.placeId ? places.get(block.placeId) : undefined;
    for (const term of [place?.district, place?.category]) {
      if (typeof term !== 'string' || !term) continue;
      const key = term.toLowerCase();
      if (seenQuery.has(key) || queries.length >= MAX_QUERIES) continue;
      seenQuery.add(key);
      queries.push(term);
    }
  }

  const seen = new Set<string>();
  const out: KnowledgeChunk[] = [];
  for (const query of queries) {
    try {
      for (const chunk of asList(await deps.knowledge.search(query, cityKey, topK))) {
        const key = `${chunk.source}::${chunk.chunk}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(chunk);
      }
    } catch {
      // Taste is decoration here; the hard rules do not depend on it.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// applyDiff — §8 step 9
// ---------------------------------------------------------------------------

/**
 * Apply only the ops the user ticked.
 *
 * The accepted list comes back from a browser, so immovability is checked again
 * here rather than assumed: replan() having refused to produce an op is no
 * guarantee that the thing being posted back is one it produced.
 *
 * budgetDelta is measured from the blocks themselves — total after minus total
 * before — rather than summed from the ops, so a refused op cannot leave the
 * number claiming a saving that did not happen.
 */
export function applyDiff(
  blocks: readonly Block[],
  acceptedOps: readonly DiffOp[],
  opts: ApplyDiffOptions = {},
): ApplyDiffResult {
  const before = asList(blocks);
  const beforeTotal = before.reduce((sum, b) => sum + costOf(b), 0);
  const violations: Violation[] = [];

  const immovableIds =
    opts.immovableIds ?? new Set(before.filter((b) => b.locked === true).map((b) => b.id));
  const byId = new Map(before.map((b) => [b.id, { ...b }]));
  const removed = new Set<string>();
  const added: Block[] = [];
  const newId = opts.newId ?? ((i: number) => `add-${String(i + 1).padStart(2, '0')}`);

  for (const entry of asList(acceptedOps)) {
    const op = entry?.op;
    if (!op) continue;
    const target = targetOf(op);

    if (target !== null) {
      if (immovableIds.has(target)) {
        violations.push(
          violation(
            'immovable_block',
            `Refused op "${op.op}": block ${target} is locked or already past and cannot be changed.`,
            { blockId: target },
          ),
        );
        continue;
      }
      if (!byId.has(target) || removed.has(target)) {
        violations.push(
          violation('unknown_block', `Refused op "${op.op}": block ${target} is not in the itinerary.`, {
            blockId: target,
          }),
        );
        continue;
      }
    }

    switch (op.op) {
      case 'keep':
        break;
      case 'remove':
        removed.add(op.blockId);
        break;
      case 'move': {
        const block = byId.get(op.blockId);
        if (!block) break;
        block.day = op.to.day;
        block.startTime = op.to.startTime;
        if (Number.isFinite(op.to.durationMin) && op.to.durationMin !== null) {
          block.durationMin = Number(op.to.durationMin);
        }
        break;
      }
      case 'add': {
        added.push({
          id: newId(added.length),
          tripId: opts.tripId ?? before[0]?.tripId ?? null,
          day: op.block.day,
          startTime: op.block.startTime,
          durationMin: op.block.durationMin,
          title: op.block.title,
          subtitle: op.block.subtitle ?? null,
          placeId: op.block.placeId,
          costPerPerson: op.block.costPerPerson,
          locked: false,
          reason: op.block.reason ?? null,
          sourceCitation: op.block.sourceCitation ?? null,
          createdBy: 'replan',
        });
        break;
      }
    }
  }

  const after = [...byId.values()].filter((b) => !removed.has(b.id)).concat(added).sort(byDayThenTime);
  const afterTotal = after.reduce((sum, b) => sum + costOf(b), 0);

  return { blocks: after, budgetDelta: afterTotal - beforeTotal, violations };
}

/**
 * What the itinerary would look like with these ops applied, checked against the
 * trip's own rules. The route handler runs this before writing.
 */
export function previewDiff(
  blocks: readonly Block[],
  acceptedOps: readonly DiffOp[],
  constraints: Constraints,
  candidates: readonly Place[],
  opts: ApplyDiffOptions = {},
): ApplyDiffResult {
  const applied = applyDiff(blocks, acceptedOps, opts);
  const { violations } = validateItinerary(applied.blocks, constraints, candidates);
  return { ...applied, violations: [...applied.violations, ...violations] };
}
