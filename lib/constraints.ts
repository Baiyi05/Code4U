/**
 * lib/constraints.ts — the rule engine (layer L3 of technical-spec §7).
 *
 * Pure functions only: no network, no LLM, no Supabase, no system clock.
 * Every date is derived from the caller's start_date + day, so results do not
 * depend on the timezone the process happens to run in.
 *
 * Covers three steps of §7:
 *   step 2  buildConstraints    — fold trip + preferences into one hard constraint set
 *   step 3  filterCandidates    — narrow the prefetched places down to one day's options
 *   step 7  validateItinerary   — post-generation hard checks (the anti-hallucination core)
 *           enforceBudget       — drop non-locked blocks until the budget fits
 *
 * Type sourcing: once lib/schemas.ts (Zod, frozen Sep 5) lands, the input types
 * below should be imported from there and re-exported instead of redefined here.
 */

// ---------------------------------------------------------------------------
// Input types (mirroring the §5 database schema)
// ---------------------------------------------------------------------------

export type Pace = 'chill' | 'balanced' | 'packed';
export type BudgetBand = 'low' | 'mid' | 'high';

export interface Trip {
  id: string;
  slug: string;
  destination: string;
  city_key: string;
  /** 'YYYY-MM-DD' */
  start_date: string;
  /** 'YYYY-MM-DD' */
  end_date: string;
  budget_per_person: number;
}

export interface Preference {
  member_id: string;
  trip_id: string;
  budget_band: BudgetBand | null;
  pace: Pace | null;
  interests: string[] | null;
  dietary: string[] | null;
  /** The schema stores text, not text[] — may hold several items, so it gets split */
  must_do: string | null;
  no_go: string | null;
}

/** 0 = Sunday … 6 = Saturday */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface TimeRange {
  /** 'HH:MM' */
  open: string;
  /** 'HH:MM'; close <= open means it runs past midnight (+24h). '25:30' also works */
  close: string;
}

/** The shape this project assumes for places.opening_hours (jsonb) */
export interface OpeningHours {
  /** A missing weekday key, or an empty array, means closed that day */
  periods?: Partial<Record<Weekday, TimeRange[]>>;
  /** 'YYYY-MM-DD' → overrides periods, for one-off closures */
  exceptions?: Record<string, TimeRange[]>;
  always_open?: boolean;
}

export interface Place {
  id: string;
  city_key: string;
  name: string;
  category: string | null;
  district: string | null;
  lat: number | null;
  lng: number | null;
  /** null or unparsable = missing data → treated as open all day (see §11 fault tolerance) */
  opening_hours: OpeningHours | null;
  est_cost_per_person: number | null;
  avg_duration_min: number | null;
  indoor: boolean;
  veg_friendly: boolean;
}

export interface Block {
  id: string;
  /** 1-based day index within the trip */
  day: number;
  /** 'HH:MM' or 'HH:MM:SS' (Postgres time columns come back as the latter) */
  start_time: string;
  duration_min: number;
  title: string;
  subtitle?: string | null;
  place_id: string | null;
  cost_per_person: number;
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface Constraints {
  city_key: string;
  /** 'YYYY-MM-DD' */
  start_date: string;
  /** end_date - start_date + 1, never below 1 */
  days: number;
  /** Per-person spending ceiling — the lowest across all members */
  budget_ceiling: number;
  blocks_per_day: number;
  /** The resolved pace, useful when writing block.reason */
  pace: Pace;
  /** These three keep the trimmed original text (case preserved); matching normalizes internally */
  required_tags: string[];
  forced: string[];
  excluded: string[];
}

export type ViolationCode =
  /** place_id is not in the candidate list — stops the LLM inventing places, §7 step 7 */
  | 'unknown_place'
  | 'missing_place'
  | 'over_budget'
  | 'overlap'
  | 'outside_opening_hours'
  | 'closed_that_day'
  | 'missing_forced'
  | 'invalid_day'
  | 'invalid_time';

export interface Violation {
  code: ViolationCode;
  /** Human-readable, safe to surface in the UI as-is */
  message: string;
  block_id?: string;
  day?: number;
  detail?: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

export const BLOCKS_PER_PACE: Readonly<Record<Pace, number>> = {
  chill: 3,
  balanced: 4,
  packed: 5,
};

/** budget_band → per-person ceiling (absolute amount, same unit as trips.budget_per_person) */
export const BAND_CEILING: Readonly<Record<BudgetBand, number>> = {
  low: 800,
  mid: 1500,
  high: 2500,
};

/** Which band a member with no stated band counts as */
const FALLBACK_BAND: BudgetBand = 'mid';

/** must_do / no_go are free text, so split them on the usual separators */
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
 * Very short match tokens cause collateral damage (a no_go of 'b' would drop every bar).
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

const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

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

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

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

/** Which calendar day the trip's Nth day falls on; null when start_date is unparsable */
function dayOf(constraints: Constraints, day: number): CalendarDay | null {
  const startMs = parseISODate(constraints?.start_date);
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
  const oh: unknown = place.opening_hours;
  if (!isObject(oh)) return null;
  if (oh['always_open'] === true) return null;

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
 * - budget_ceiling takes the LOWEST member ceiling, not the average
 * - blocks_per_day follows the sole most-voted pace; a tie (or no votes) falls back to defaultPace
 * - required_tags / forced / excluded are the unions of dietary / must_do / no_go
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

  // --- budget_ceiling: whoever has the least room sets it ---
  let lowest: number | null = null;
  for (const p of prefs) {
    const band = isBand(p.budget_band) ? p.budget_band : FALLBACK_BAND;
    const value = bandCeiling[band];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    lowest = lowest === null ? value : Math.min(lowest, value);
  }
  // With zero preferences there is no band to read, so fall back to the trip's per-person budget
  const budget_ceiling =
    lowest ?? finiteOr(trip?.budget_per_person, finiteOr(bandCeiling[FALLBACK_BAND], 0));

  // --- pace: sole winner, otherwise defaultPace ---
  const tally: Record<Pace, number> = { chill: 0, balanced: 0, packed: 0 };
  for (const p of prefs) {
    if (isPace(p.pace)) tally[p.pace] += 1;
  }
  const top = Math.max(tally.chill, tally.balanced, tally.packed);
  const leaders = PACES.filter((k) => tally[k] === top);
  const pace: Pace = top > 0 && leaders.length === 1 ? leaders[0]! : defaultPace;
  const blocks_per_day = finiteOr(
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

  const required_tags = dedupe(splitAll(prefs.flatMap((p) => toStringArray(p.dietary))));
  const forced = dedupe(
    splitAll(prefs.map((p) => p.must_do).filter((v): v is string => typeof v === 'string')),
  );
  const excluded = dedupe(
    splitAll(prefs.map((p) => p.no_go).filter((v): v is string => typeof v === 'string')),
  );

  // --- trip length ---
  const startMs = parseISODate(trip?.start_date);
  const endMs = parseISODate(trip?.end_date);
  const days =
    startMs !== null && endMs !== null
      ? Math.max(1, Math.round((endMs - startMs) / MS_PER_DAY) + 1)
      : 1;

  return {
    city_key: typeof trip?.city_key === 'string' ? trip.city_key : '',
    start_date: typeof trip?.start_date === 'string' ? trip.start_date : '',
    days,
    budget_ceiling,
    blocks_per_day,
    pace,
    required_tags,
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
 * required_tags is deliberately not a hard filter here — diet is a soft preference,
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
    if (place.city_key !== constraints.city_key) return false;
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
  const ceiling = finiteOr(constraints?.budget_ceiling, Number.POSITIVE_INFINITY);
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
        block_id: block.id,
        detail: { day: block.day, days },
      });
    }

    // --- place_id must come from the candidate list (stops invented places) ---
    if (typeof block.place_id !== 'string' || !block.place_id) {
      violations.push({
        code: 'missing_place',
        message: `"${label}" has no place_id`,
        block_id: block.id,
        day: block.day,
      });
    } else if (!ids.has(block.place_id)) {
      violations.push({
        code: 'unknown_place',
        message: `"${label}" points at place_id ${block.place_id}, which is not in the candidate list`,
        block_id: block.id,
        day: block.day,
        detail: { place_id: block.place_id },
      });
    }

    // --- time has to parse ---
    const start = parseClock(block.start_time);
    const duration = block.duration_min;
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
          `(start_time = ${String(block.start_time)}, duration_min = ${String(duration)})`,
        block_id: block.id,
        day: block.day,
        detail: { start_time: block.start_time, duration_min: duration },
      });
      continue;
    }

    const timed: Timed = { block, start, end: start + duration };
    const bucket = byDay.get(block.day);
    if (bucket) bucket.push(timed);
    else byDay.set(block.day, [timed]);

    // --- opening hours (only checkable when the Place object is on hand) ---
    if (places && typeof block.place_id === 'string') {
      const place = places.get(block.place_id);
      if (place) {
        const when = dayOf(constraints, block.day);
        const ranges = rangesForDay(place, when);
        if (ranges !== null && ranges.length === 0) {
          violations.push({
            code: 'closed_that_day',
            message: `"${place.name}" is closed all day on day ${block.day}`,
            block_id: block.id,
            day: block.day,
            detail: { place_id: place.id, date: when?.iso },
          });
        } else if (!isOpenDuring(ranges, timed.start, timed.end)) {
          violations.push({
            code: 'outside_opening_hours',
            message:
              `"${label}" is scheduled ${formatClock(timed.start)}–${formatClock(timed.end)}, ` +
              `outside the opening hours of "${place.name}"`,
            block_id: block.id,
            day: block.day,
            detail: {
              place_id: place.id,
              block: `${formatClock(timed.start)}-${formatClock(timed.end)}`,
              hours: (ranges ?? []).map((r) => `${formatClock(r.start)}-${formatClock(r.end)}`),
            },
          });
        }
      }
    }
  }

  // --- total spend within budget_ceiling ---
  const total = list.reduce((sum, b) => sum + finiteOr(b.cost_per_person, 0), 0);
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
          block_id: a.block.id,
          day,
          detail: { with_block_id: b.block.id },
        });
      }
    }
  }

  // --- everything in `forced` has to show up ---
  const haystacks = list.map((b) =>
    haystackOf(b, places && typeof b.place_id === 'string' ? places.get(b.place_id) : undefined),
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
  return finiteOr(block.cost_per_person, 0);
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
 * - Ties break on later start_time first, then on later original index — so the
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
  const ceiling = finiteOr(constraints?.budget_ceiling, Number.POSITIVE_INFINITY);

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
      start: parseClock(block.start_time) ?? -1,
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
