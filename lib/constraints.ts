/**
 * lib/constraints.ts — the rule engine (layer L3 of technical-spec §7).
 *
 * Pure functions only: no network, no LLM, no Supabase, no system clock.
 * Every date is derived from the caller's startDate + day, so results do not
 * depend on the timezone the process happens to run in.
 *
 * Covers three steps of §7:
 *   step 2  buildConstraints    — fold trip + preferences into one hard constraint set
 *   step 3  filterCandidates    — narrow the prefetched places down to one day's options
 *   step 7  validateItinerary   — post-generation hard checks (the anti-hallucination core)
 *           enforceBudget       — drop non-locked blocks until the budget fits
 *
 * Every type it touches comes from lib/schemas.ts. That file is the single
 * source of truth for the project; nothing is redefined here.
 */

import {
  CLOCK_RE,
  ISO_DATE_RE,
  type Block,
  type BudgetBand,
  type Constraints,
  type Pace,
  type Place,
  type Preference,
  type Trip,
  type ValidationResult,
  type Violation,
  type Weekday,
} from './schemas';

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

export const BLOCKS_PER_PACE: Readonly<Record<Pace, number>> = {
  chill: 3,
  balanced: 4,
  packed: 5,
};

/** budgetBand → per-person ceiling (absolute amount, same unit as trips.budgetPerPerson) */
export const BAND_CEILING: Readonly<Record<BudgetBand, number>> = {
  low: 800,
  mid: 1500,
  high: 2500,
};

/** Which band a member with no stated band counts as */
const FALLBACK_BAND: BudgetBand = 'mid';

/** mustDo / noGo are free text, so split them on the usual separators */
const FREE_TEXT_SEPARATORS = /[,，、;；\n\r]+/;

export interface BuildConstraintsOptions {
  bandCeiling?: Record<BudgetBand, number>;
  blocksPerPace?: Record<Pace, number>;
  /** Used when the pace vote ties or nobody stated one; defaults to 'balanced' */
  defaultPace?: Pace;
  splitFreeText?: (value: string) => string[];
}

export interface FilterOptions {
  /** Which place fields `excluded` is matched against; defaults to ['category', 'name'] */
  matchExcludedAgainst?: ReadonlyArray<'category' | 'name' | 'district'>;
}

export interface EnforceBudgetOptions {
  /** When true, blocks matching `forced` are cut last; defaults to false (literal §7) */
  protectForced?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PACES: readonly Pace[] = ['chill', 'balanced', 'packed'];
const BANDS: readonly BudgetBand[] = ['low', 'mid', 'high'];
const MINUTES_PER_DAY = 1440;
const MS_PER_DAY = 86_400_000;

function isPace(value: unknown): value is Pace {
  return typeof value === 'string' && (PACES as readonly string[]).includes(value);
}

function isBand(value: unknown): value is BudgetBand {
  return typeof value === 'string' && (BANDS as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Same non-null-object check, but deliberately NOT a type guard. Use it on values
 * that already have a static type and are merely untrusted at runtime (a Supabase
 * or LLM array can contain nulls) — narrowing those to Record would lose the type.
 */
function isFilled(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * Coerce an untrusted argument to an array. Do not inline Array.isArray at the call
 * site: against a readonly T[] it narrows to any[], which degrades everything downstream.
 */
function asArray<T>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Normalization used for matching: trim, lowercase, collapse inner whitespace */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Very short match tokens cause collateral damage (a noGo of 'b' would drop every bar).
 * Single ASCII characters are ignored; a single non-ASCII character is meaningful in
 * languages that write words as one glyph, so those are kept.
 */
function isUsableToken(token: string): boolean {
  return token.length >= 2 || /[^\x00-\x7f]/.test(token);
}

/** Drop blanks and case-insensitive duplicates, keeping the first spelling seen */
function dedupe(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function defaultSplitFreeText(value: string): string[] {
  return value.split(FREE_TEXT_SEPARATORS);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// --- Time ------------------------------------------------------------------

/** 'HH:MM' / 'HH:MM:SS' → minutes past midnight; hours 24–47 express past-midnight. null if unparsable */
function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = CLOCK_RE.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 47 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatClock(totalMinutes: number): string {
  const m = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// --- Dates (pure UTC arithmetic, immune to the local timezone) --------------

function parseISODate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DATE_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const dayOfMonth = Number(m[3]);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  const ms = Date.UTC(year, month - 1, dayOfMonth);
  if (!Number.isFinite(ms)) return null;
  // Round-trip it to reject dates like Feb 30 that Date.UTC silently rolls over
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }
  return ms;
}

interface CalendarDay {
  /** 'YYYY-MM-DD' */
  iso: string;
  weekday: Weekday;
}

function calendarDay(startMs: number, dayIndex: number): CalendarDay {
  const dt = new Date(startMs + (dayIndex - 1) * MS_PER_DAY);
  const iso =
    `${String(dt.getUTCFullYear()).padStart(4, '0')}-` +
    `${String(dt.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(dt.getUTCDate()).padStart(2, '0')}`;
  return { iso, weekday: dt.getUTCDay() as Weekday };
}

/** Which calendar day the trip's Nth day falls on; null when startDate is unparsable */
function dayOf(constraints: Constraints, day: number): CalendarDay | null {
  const startMs = parseISODate(constraints?.startDate);
  if (startMs === null || !Number.isInteger(day)) return null;
  return calendarDay(startMs, day);
}

// --- Opening hours ---------------------------------------------------------

interface Interval {
  start: number;
  end: number;
}

/**
 * The opening intervals for one day.
 *   null → data missing or unparsable, treated as open all day (better to keep a
 *          place in the pool than to wash the candidate list out entirely)
 *   []   → closed that day
 */
function rangesForDay(place: Place, when: CalendarDay | null): Interval[] | null {
  const oh: unknown = place.openingHours;
  if (!isObject(oh)) return null;
  if (oh['alwaysOpen'] === true) return null;

  let raw: unknown;
  let matched = false;

  const exceptions = oh['exceptions'];
  if (when && isObject(exceptions) && Object.prototype.hasOwnProperty.call(exceptions, when.iso)) {
    raw = exceptions[when.iso];
    matched = true;
  }

  const periods = oh['periods'];
  if (!matched && when && isObject(periods)) {
    const key = String(when.weekday);
    if (Object.prototype.hasOwnProperty.call(periods, key)) {
      raw = periods[key];
      matched = true;
    } else {
      // periods is present but says nothing about this weekday → closed
      return [];
    }
  }

  if (!matched) return null;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [];

  const intervals: Interval[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const start = parseClock(entry['open']);
    let end = parseClock(entry['close']);
    if (start === null || end === null) continue;
    if (end <= start) end += MINUTES_PER_DAY; // runs past midnight, e.g. 18:00–02:00
    intervals.push({ start, end });
  }
  // Intervals were listed but none parsed → treat as unknown rather than closed
  return intervals.length > 0 ? intervals : null;
}

/** [start, end] has to sit entirely inside one opening interval */
function isOpenDuring(ranges: Interval[] | null, start: number, end: number): boolean {
  if (ranges === null) return true;
  if (ranges.length === 0) return false;
  return ranges.some(
    (r) =>
      (start >= r.start && end <= r.end) ||
      // An after-midnight block may belong to the previous evening's interval
      // (00:30 sits inside 18:00–26:00)
      (start + MINUTES_PER_DAY >= r.start && end + MINUTES_PER_DAY <= r.end),
  );
}

// ---------------------------------------------------------------------------
// 1. buildConstraints
// ---------------------------------------------------------------------------

/**
 * Fold a trip and everyone's preferences into one hard constraint set (§7 step 2).
 *
 * - budgetCeiling takes the LOWEST member ceiling, not the average
 * - blocksPerDay follows the sole most-voted pace; a tie (or no votes) falls back to defaultPace
 * - requiredTags / forced / excluded are the unions of dietary / mustDo / noGo
 */
export function buildConstraints(
  trip: Trip,
  preferences: readonly Preference[] = [],
  opts: BuildConstraintsOptions = {},
): Constraints {
  const bandCeiling = opts.bandCeiling ?? BAND_CEILING;
  const blocksPerPace = opts.blocksPerPace ?? BLOCKS_PER_PACE;
  const defaultPace = isPace(opts.defaultPace) ? opts.defaultPace : 'balanced';
  const split = opts.splitFreeText ?? defaultSplitFreeText;

  const prefs = asArray(preferences).filter((p) => isFilled(p));

  // --- budgetCeiling: whoever has the least room sets it ---
  let lowest: number | null = null;
  for (const p of prefs) {
    const band = isBand(p.budgetBand) ? p.budgetBand : FALLBACK_BAND;
    const value = bandCeiling[band];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    lowest = lowest === null ? value : Math.min(lowest, value);
  }
  // With zero preferences there is no band to read, so fall back to the trip's per-person budget
  const budgetCeiling =
    lowest ?? finiteOr(trip?.budgetPerPerson, finiteOr(bandCeiling[FALLBACK_BAND], 0));

  // --- pace: sole winner, otherwise defaultPace ---
  const tally: Record<Pace, number> = { chill: 0, balanced: 0, packed: 0 };
  for (const p of prefs) {
    if (isPace(p.pace)) tally[p.pace] += 1;
  }
  const top = Math.max(tally.chill, tally.balanced, tally.packed);
  const leaders = PACES.filter((k) => tally[k] === top);
  const pace: Pace = top > 0 && leaders.length === 1 ? leaders[0]! : defaultPace;
  const blocksPerDay = finiteOr(
    blocksPerPace[pace],
    finiteOr(BLOCKS_PER_PACE[pace], BLOCKS_PER_PACE.balanced),
  );

  // --- the three tag sets ---
  const splitAll = (values: Iterable<string>): string[] => {
    const out: string[] = [];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const pieces = split(value);
      if (!Array.isArray(pieces)) continue;
      for (const piece of pieces) out.push(piece);
    }
    return out;
  };

  const requiredTags = dedupe(splitAll(prefs.flatMap((p) => toStringArray(p.dietary))));
  const forced = dedupe(
    splitAll(prefs.map((p) => p.mustDo).filter((v): v is string => typeof v === 'string')),
  );
  const excluded = dedupe(
    splitAll(prefs.map((p) => p.noGo).filter((v): v is string => typeof v === 'string')),
  );

  // --- trip length ---
  const startMs = parseISODate(trip?.startDate);
  const endMs = parseISODate(trip?.endDate);
  const days =
    startMs !== null && endMs !== null
      ? Math.max(1, Math.round((endMs - startMs) / MS_PER_DAY) + 1)
      : 1;

  return {
    cityKey: typeof trip?.cityKey === 'string' ? trip.cityKey : '',
    startDate: typeof trip?.startDate === 'string' ? trip.startDate : '',
    days,
    budgetCeiling,
    blocksPerDay,
    pace,
    requiredTags,
    forced,
    excluded,
  };
}

// ---------------------------------------------------------------------------
// 2. filterCandidates
// ---------------------------------------------------------------------------

function matchesExcluded(
  place: Place,
  tokens: readonly string[],
  fields: ReadonlyArray<'category' | 'name' | 'district'>,
): boolean {
  if (tokens.length === 0) return false;
  for (const field of fields) {
    const value = place[field];
    if (typeof value !== 'string' || !value) continue;
    const haystack = normalize(value);
    if (tokens.some((t) => haystack.includes(t))) return true;
  }
  return false;
}

/**
 * Narrow the prefetched places down to what is usable on day N (§7 step 3).
 * Drops, in order: wrong city → matches `excluded` → closed that day.
 *
 * requiredTags is deliberately not a hard filter here — diet is a soft preference,
 * and filtering on it would empty the candidate pool.
 */
export function filterCandidates<P extends Place>(
  places: readonly P[],
  constraints: Constraints,
  day: number,
  opts: FilterOptions = {},
): P[] {
  const fields = opts.matchExcludedAgainst ?? (['category', 'name'] as const);
  const tokens = (constraints?.excluded ?? []).map(normalize).filter(isUsableToken);
  const when = dayOf(constraints, day);

  return asArray(places).filter((place) => {
    if (!isFilled(place)) return false;
    if (place.cityKey !== constraints.cityKey) return false;
    if (matchesExcluded(place, tokens, fields)) return false;
    const ranges = rangesForDay(place, when);
    if (ranges !== null && ranges.length === 0) return false; // closed that day
    return true;
  });
}

// ---------------------------------------------------------------------------
// 3. validateItinerary
// ---------------------------------------------------------------------------

interface CandidateIndex {
  ids: Set<string>;
  /** null when only ids were supplied → opening-hours checks are skipped */
  places: Map<string, Place> | null;
}

function indexCandidates(
  candidates: readonly Place[] | Iterable<string> | null | undefined,
): CandidateIndex {
  const ids = new Set<string>();
  const places = new Map<string, Place>();
  let sawPlace = false;

  const iterable = candidates as Iterable<unknown> | null | undefined;
  if (iterable && typeof iterable[Symbol.iterator] === 'function') {
    for (const item of iterable) {
      if (typeof item === 'string') {
        if (item) ids.add(item);
      } else if (isObject(item) && typeof item['id'] === 'string' && item['id']) {
        sawPlace = true;
        ids.add(item['id']);
        places.set(item['id'], item as unknown as Place);
      }
    }
  }
  return { ids, places: sawPlace ? places : null };
}

function haystackOf(block: Block, place: Place | undefined): string {
  return normalize(
    [block.title, block.subtitle, place?.name].filter((v) => typeof v === 'string').join(' '),
  );
}

/**
 * The post-generation hard checks (§7 step 7) — the core of the anti-hallucination design.
 * Collects every violation and returns them; it never throws.
 *
 * Pass Place[] (what filterCandidates returns) to run all six checks. Pass a plain id
 * list and the two opening-hours checks are skipped while the rest still run.
 */
export function validateItinerary(
  blocks: readonly Block[],
  constraints: Constraints,
  candidates: readonly Place[] | Iterable<string>,
): ValidationResult {
  const violations: Violation[] = [];
  const list = asArray(blocks).filter((b) => isFilled(b));
  const { ids, places } = indexCandidates(candidates);
  const ceiling = finiteOr(constraints?.budgetCeiling, Number.POSITIVE_INFINITY);
  const days = finiteOr(constraints?.days, Number.POSITIVE_INFINITY);

  interface Timed {
    block: Block;
    start: number;
    end: number;
  }
  const byDay = new Map<number, Timed[]>();

  for (const block of list) {
    const label = block.title || block.id || '(untitled)';

    // --- day sits inside the trip ---
    if (!(Number.isInteger(block.day) && block.day >= 1 && block.day <= days)) {
      violations.push({
        code: 'invalid_day',
        message: `"${label}" has day = ${String(block.day)}, outside the trip range 1–${days}`,
        blockId: block.id,
        detail: { day: block.day, days },
      });
    }

    // --- placeId must come from the candidate list (stops invented places) ---
    if (typeof block.placeId !== 'string' || !block.placeId) {
      violations.push({
        code: 'missing_place',
        message: `"${label}" has no placeId`,
        blockId: block.id,
        day: block.day,
      });
    } else if (!ids.has(block.placeId)) {
      violations.push({
        code: 'unknown_place',
        message: `"${label}" points at placeId ${block.placeId}, which is not in the candidate list`,
        blockId: block.id,
        day: block.day,
        detail: { placeId: block.placeId },
      });
    }

    // --- time has to parse ---
    const start = parseClock(block.startTime);
    const duration = block.durationMin;
    if (
      start === null ||
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      violations.push({
        code: 'invalid_time',
        message:
          `"${label}" has an unreadable time ` +
          `(startTime = ${String(block.startTime)}, durationMin = ${String(duration)})`,
        blockId: block.id,
        day: block.day,
        detail: { startTime: block.startTime, durationMin: duration },
      });
      continue;
    }

    const timed: Timed = { block, start, end: start + duration };
    const bucket = byDay.get(block.day);
    if (bucket) bucket.push(timed);
    else byDay.set(block.day, [timed]);

    // --- opening hours (only checkable when the Place object is on hand) ---
    if (places && typeof block.placeId === 'string') {
      const place = places.get(block.placeId);
      if (place) {
        const when = dayOf(constraints, block.day);
        const ranges = rangesForDay(place, when);
        if (ranges !== null && ranges.length === 0) {
          violations.push({
            code: 'closed_that_day',
            message: `"${place.name}" is closed all day on day ${block.day}`,
            blockId: block.id,
            day: block.day,
            detail: { placeId: place.id, date: when?.iso },
          });
        } else if (!isOpenDuring(ranges, timed.start, timed.end)) {
          violations.push({
            code: 'outside_opening_hours',
            message:
              `"${label}" is scheduled ${formatClock(timed.start)}–${formatClock(timed.end)}, ` +
              `outside the opening hours of "${place.name}"`,
            blockId: block.id,
            day: block.day,
            detail: {
              placeId: place.id,
              block: `${formatClock(timed.start)}-${formatClock(timed.end)}`,
              hours: (ranges ?? []).map((r) => `${formatClock(r.start)}-${formatClock(r.end)}`),
            },
          });
        }
      }
    }
  }

  // --- total spend within budgetCeiling ---
  const total = list.reduce((sum, b) => sum + finiteOr(b.costPerPerson, 0), 0);
  if (total > ceiling) {
    violations.push({
      code: 'over_budget',
      message: `Total cost per person is ${total}, over the ceiling of ${ceiling}`,
      detail: { total, ceiling, over: total - ceiling },
    });
  }

  // --- no overlaps within a day (a day holds very few blocks, so compare every pair) ---
  for (const [day, items] of byDay) {
    const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (b.start >= a.end) break; // sorted by start, so nothing later can overlap either
        violations.push({
          code: 'overlap',
          message:
            `Day ${day}: "${a.block.title}" (${formatClock(a.start)}–${formatClock(a.end)}) ` +
            `overlaps "${b.block.title}" (${formatClock(b.start)}–${formatClock(b.end)})`,
          blockId: a.block.id,
          day,
          detail: { withBlockId: b.block.id },
        });
      }
    }
  }

  // --- everything in `forced` has to show up ---
  const haystacks = list.map((b) =>
    haystackOf(b, places && typeof b.placeId === 'string' ? places.get(b.placeId) : undefined),
  );
  for (const item of constraints?.forced ?? []) {
    const token = normalize(item);
    if (!isUsableToken(token)) continue;
    if (!haystacks.some((h) => h.includes(token))) {
      violations.push({
        code: 'missing_forced',
        message: `Required item "${item}" does not appear in the itinerary`,
        detail: { item },
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// 4. enforceBudget
// ---------------------------------------------------------------------------

function costOf(block: Block): number {
  return finiteOr(block.costPerPerson, 0);
}

/** Total cost per person */
export function totalCost(blocks: readonly Block[]): number {
  return asArray(blocks).reduce((sum, b) => (isFilled(b) ? sum + costOf(b) : sum), 0);
}

/**
 * Drop non-locked blocks, most expensive first, until the budget fits (§7 step 7).
 *
 * - Locked blocks are never dropped. If everything is locked and the total is still
 *   over, the list comes back untouched and validateItinerary reports over_budget
 * - Ties break on later startTime first, then on later original index — so the
 *   result is deterministic and the tests stay stable
 * - Blocks costing 0 save nothing, so they are left alone
 * - The surviving blocks keep their original order
 */
export function enforceBudget<B extends Block>(
  blocks: readonly B[],
  constraints: Constraints,
  opts: EnforceBudgetOptions = {},
): B[] {
  const list = asArray(blocks).filter((b) => isFilled(b));
  const ceiling = finiteOr(constraints?.budgetCeiling, Number.POSITIVE_INFINITY);

  let total = list.reduce((sum, b) => sum + costOf(b), 0);
  if (total <= ceiling) return [...list];

  const forcedTokens = opts.protectForced
    ? (constraints?.forced ?? []).map(normalize).filter(isUsableToken)
    : [];
  const isForced = (block: B): boolean => {
    if (forcedTokens.length === 0) return false;
    const haystack = haystackOf(block, undefined);
    return forcedTokens.some((t) => haystack.includes(t));
  };

  const removable = list
    .map((block, index) => ({
      block,
      index,
      cost: costOf(block),
      forced: isForced(block),
      start: parseClock(block.startTime) ?? -1,
    }))
    .filter((x) => x.block.locked !== true && x.cost > 0)
    .sort(
      (a, b) =>
        Number(a.forced) - Number(b.forced) || // protected ones go last
        b.cost - a.cost || //                     most expensive first
        b.start - a.start || //                   same cost: later in the day first
        b.index - a.index, //                     still tied: later in the list first
    );

  const dropped = new Set<number>();
  for (const candidate of removable) {
    if (total <= ceiling) break;
    dropped.add(candidate.index);
    total -= candidate.cost;
  }

  return list.filter((_, index) => !dropped.has(index));
}
