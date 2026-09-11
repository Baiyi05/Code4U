/**
 * lib/demo-data.ts — everything the prototype shows, in one file.
 *
 * No Supabase, no LLM, no route handler. The seven screens read this and nothing
 * else. The one thing deliberately NOT hand-written here is the re-plan diffs:
 * those come out of the real §8 engine and are committed as demo-diffs.json,
 * generated and re-verified by lib/demo-data.test.ts.
 *
 * Where the numbers come from:
 *   - places      seeds/osaka-places.json, unchanged, via lib/seed.ts
 *   - citations   lib/__mocks__/knowledge.ts — real retrieved text, not invented
 *   - costs       illustrative RM figures for a mid-range Osaka trip. Plausible,
 *                 not researched. The point of the prototype is that the
 *                 arithmetic on top of them is real, not that they are quotes.
 */

import { z } from 'zod';

import { buildConstraints } from './constraints';
import { DEMO_BLOCKS } from './demo-data-blocks';
import rawDiffs from './demo-diffs.json';
import rawKnowledge from './place-knowledge.json';
import rawMedia from './place-media.json';
import { hasPassed, type TripNow } from './replan';
import { SEED_PLACES } from './seed';
import {
  DiffOpSchema,
  KnowledgeChunkSchema,
  TimeWindowSchema,
  ViolationSchema,
  type Block,
  type DiffOp,
  type KnowledgeChunk,
  type Constraints,
  type Disruption,
  type Member,
  type Place,
  type Preference,
  type SourceCitation,
  type Trip,
} from './schemas';

export { DEMO_BLOCKS };

// ---------------------------------------------------------------------------
// Trip
// ---------------------------------------------------------------------------

export const DEMO_TRIP: Trip = {
  id: 'demo-trip-osaka',
  slug: 'OSK-4K2',
  destination: 'Osaka, Japan',
  cityKey: 'osaka',
  startDate: '2026-09-07',
  endDate: '2026-09-11',
  budgetPerPerson: 3000,
  timezone: 'Asia/Tokyo',
  captainId: 'm-wei',
  createdAt: '2026-08-30T09:12:00Z',
};

export const DEMO_PLACES: Place[] = SEED_PLACES;

export const PLACES_BY_ID: ReadonlyMap<string, Place> = new Map(
  DEMO_PLACES.map((place) => [place.id, place]),
);

/** Where the invite link points. There is no server, so the slug is the whole trip. */
export const INVITE_URL = `https://detour.trip/j/${DEMO_TRIP.slug}`;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface DemoMember extends Member {
  /** initials for the avatar — a prototype has no photos */
  initials: string;
  /** a tint class, so the same person is recognisable across all seven screens */
  tint: string;
}

export const DEMO_MEMBERS: DemoMember[] = [
  {
    id: 'm-wei',
    tripId: DEMO_TRIP.id,
    displayName: 'Wei',
    isCaptain: true,
    initials: 'W',
    tint: 'bg-accent-soft text-accent-ink',
  },
  {
    id: 'm-amirah',
    tripId: DEMO_TRIP.id,
    displayName: 'Amirah',
    isCaptain: false,
    initials: 'A',
    tint: 'bg-added-soft text-added',
  },
  {
    id: 'm-jia',
    tripId: DEMO_TRIP.id,
    displayName: 'Jia',
    isCaptain: false,
    initials: 'J',
    tint: 'bg-moved-soft text-moved',
  },
  {
    id: 'm-sarah',
    tripId: DEMO_TRIP.id,
    displayName: 'Sarah',
    isCaptain: false,
    initials: 'S',
    tint: 'bg-removed-soft text-removed',
  },
];

export const DEMO_PREFERENCES: Preference[] = [
  {
    memberId: 'm-wei',
    tripId: DEMO_TRIP.id,
    budgetBand: 'high',
    pace: 'balanced',
    interests: ['history', 'architecture'],
    dietary: null,
    mustDo: 'Osaka Castle',
    noGo: 'nightclub',
  },
  {
    memberId: 'm-amirah',
    tripId: DEMO_TRIP.id,
    budgetBand: 'low',
    pace: 'chill',
    interests: ['parks', 'museums'],
    dietary: ['vegetarian'],
    mustDo: null,
    noGo: 'karaoke',
  },
  {
    memberId: 'm-jia',
    tripId: DEMO_TRIP.id,
    budgetBand: 'mid',
    pace: 'balanced',
    interests: ['street food', 'nightlife'],
    dietary: ['no pork'],
    mustDo: 'Dotonbori',
    noGo: null,
  },
  {
    memberId: 'm-sarah',
    tripId: DEMO_TRIP.id,
    budgetBand: 'mid',
    pace: 'packed',
    interests: ['theme parks', 'views'],
    dietary: null,
    mustDo: 'Universal Studios',
    noGo: null,
  },
];

/**
 * The fifth member, filled in live on the Preference Intake screen.
 *
 * The presets collide with the group on purpose: `packed` pushes the pace vote
 * from 3–1 to 3–2, and `halal` next to Amirah's `vegetarian` grows a dietary
 * conflict card that does not exist before they join. That new card appearing is
 * the whole point of walking through the questionnaire on stage.
 */
export const JOINING_MEMBER: DemoMember = {
  id: 'm-nabil',
  tripId: DEMO_TRIP.id,
  displayName: 'Nabil',
  isCaptain: false,
  initials: 'N',
  tint: 'bg-kept-soft text-kept',
};

export const JOINING_PREFERENCE: Preference = {
  memberId: JOINING_MEMBER.id,
  tripId: DEMO_TRIP.id,
  budgetBand: 'mid',
  pace: 'packed',
  interests: ['street food', 'nightlife'],
  dietary: ['halal'],
  mustDo: 'Kuromon Market',
  noGo: null,
};

// ---------------------------------------------------------------------------
// Constraints — always derived, never typed in
// ---------------------------------------------------------------------------

/**
 * The rule layer's view of this trip.
 *
 * Called with whatever preferences are currently in state, so adding the fifth
 * member on the intake screen re-derives the ceiling, the pace and the tags for
 * free. The band spread is high / low / mid / mid, so the ceiling is 0.85 of
 * RM 3,000 — the lowest member's share, never the average.
 */
export function demoConstraints(preferences: readonly Preference[] = DEMO_PREFERENCES): Constraints {
  return buildConstraints(DEMO_TRIP, [...preferences]);
}

export const DEMO_CONSTRAINTS: Constraints = demoConstraints();

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

export interface DemoDay {
  /** 1-based, the same index the engines use */
  day: number;
  /** 'Mon' */
  weekday: string;
  /** '7 Sep' */
  date: string;
  /** 'Monday 7 September' */
  long: string;
}

function dayDate(day: number): Date {
  const [y, m, d] = DEMO_TRIP.startDate.split('-').map(Number);
  return new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, (d ?? 1) + day - 1));
}

function fmt(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options }).format(date);
}

export const DEMO_DAYS: DemoDay[] = Array.from(
  { length: Math.max(1, DEMO_CONSTRAINTS.days) },
  (_, index) => {
    const date = dayDate(index + 1);
    return {
      day: index + 1,
      weekday: fmt(date, { weekday: 'short' }),
      date: fmt(date, { day: 'numeric', month: 'short' }),
      long: fmt(date, { weekday: 'long', day: 'numeric', month: 'long' }),
    };
  },
);

// ---------------------------------------------------------------------------
// Re-plan scenarios
// ---------------------------------------------------------------------------

export type ScenarioKey = 'delay' | 'weather' | 'closed' | 'overbudget';

export interface DemoScenario {
  key: ScenarioKey;
  /** the button on the trigger screen */
  label: string;
  /** the strip above the diff, e.g. 'RE-PLAN · FLIGHT DELAYED 3H' */
  headline: string;
  /** one line under the button explaining what it simulates */
  blurb: string;
  /** what the rule layer is handed */
  disruption: Disruption;
  /**
   * Where the trip is when it fires. Injected, never read from the clock — it is
   * what decides which blocks count as already past, and therefore untouchable.
   */
  now: TripNow;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    key: 'delay',
    label: 'Flight delayed 3 h',
    headline: 'RE-PLAN · FLIGHT DELAYED 3H',
    blurb: 'You land at 12:30 instead of 09:30. Day 1 has to start again.',
    disruption: {
      type: 'delay',
      day: 1,
      payload: { hours: 3, note: 'MH52 pushed back to a 12:10 landing at KIX.' },
    },
    now: { day: 1, time: '09:00' },
  },
  {
    key: 'weather',
    label: 'Rain all day',
    headline: 'RE-PLAN · HEAVY RAIN, DAY 5',
    blurb: 'The last day is a washout. Everything outdoors has to become indoors.',
    disruption: {
      type: 'weather',
      day: 5,
      payload: { condition: 'heavy rain from 09:00, 24 mm forecast' },
    },
    now: { day: 5, time: '08:00' },
  },
  {
    key: 'closed',
    label: 'Aquarium closed',
    headline: 'RE-PLAN · KAIYUKAN CLOSED',
    blurb: 'Kaiyukan shut for unscheduled maintenance. The bay morning is gone.',
    disruption: {
      type: 'closed',
      day: 2,
      payload: { placeId: 'kaiyukan', note: 'Unscheduled tank maintenance, reopens tomorrow.' },
    },
    now: { day: 2, time: '08:00' },
  },
  {
    key: 'overbudget',
    label: 'Tighten to RM 1,600',
    headline: 'RE-PLAN · BUDGET TIGHTENED',
    blurb: 'Wei drops the ceiling mid-trip. Find the difference without touching what is locked.',
    disruption: {
      type: 'overbudget',
      day: 2,
      payload: { target: 1600 },
    },
    now: { day: 2, time: '12:00' },
  },
];

export const SCENARIOS_BY_KEY: ReadonlyMap<ScenarioKey, DemoScenario> = new Map(
  DEMO_SCENARIOS.map((scenario) => [scenario.key, scenario]),
);

// ---------------------------------------------------------------------------
// The diffs — produced by the engine, not written here
// ---------------------------------------------------------------------------

/**
 * One re-plan, as lib/replan.ts returned it.
 *
 * Generated by lib/demo-data.test.ts, which runs the real §8 pipeline against a
 * fixed model reply and writes what comes back to demo-diffs.json. Nothing in
 * here was typed by hand: the costs, the immovable set, the window and the
 * violations are all the engine's own output, and the test fails if this file
 * stops matching what the engine produces.
 *
 * It is parsed on the way in for the same reason every other boundary in this
 * project is: a JSON file is untyped until something checks it.
 */
const StoredDiffSchema = z.object({
  ops: z.array(DiffOpSchema),
  budgetDelta: z.number(),
  violations: z.array(ViolationSchema),
  window: TimeWindowSchema,
  /** block ids the engine refused to touch */
  immovable: z.array(z.string()),
  /** block ids it was allowed to change */
  movable: z.array(z.string()),
  citations: z.array(KnowledgeChunkSchema),
  source: z.string(),
  /** overbudget only: how much per person had to come off */
  shortfall: z.number(),
});
export type StoredDiff = z.infer<typeof StoredDiffSchema>;

export const DEMO_DIFFS: Record<string, StoredDiff> = z
  .record(z.string(), StoredDiffSchema)
  .parse(rawDiffs);

export function diffFor(key: ScenarioKey): StoredDiff {
  const diff = DEMO_DIFFS[key];
  if (!diff) throw new Error(`demo-data: no generated diff for scenario "${key}"`);
  return diff;
}

// ---------------------------------------------------------------------------
// Helpers the screens share
// ---------------------------------------------------------------------------

export function formatRM(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '−' : '';
  return `${sign}RM ${Math.abs(rounded).toLocaleString('en-GB')}`;
}

/** '+RM 40' / '−RM 105' / 'RM 0' — for a number whose direction is the point. */
export function formatDelta(amount: number): string {
  const rounded = Math.round(amount);
  if (rounded === 0) return 'RM 0';
  return `${rounded > 0 ? '+' : '−'}RM ${Math.abs(rounded).toLocaleString('en-GB')}`;
}

export function endTime(block: Block): string {
  const [h, m] = block.startTime.split(':').map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + (Number.isFinite(block.durationMin) ? block.durationMin : 0);
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function durationLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

const EARTH_RADIUS_M = 6_371_000;
/** Straight lines underestimate streets; 1.3 is the usual correction. */
const STREET_FACTOR = 1.3;
const METRES_PER_MINUTE = 80;

/**
 * Rough walking minutes between two blocks.
 *
 * Great-circle distance between the two places, bent by a street factor. It is an
 * estimate and the UI says so — the alternative would be a Directions API call,
 * which §10 rules out for a demo.
 */
export function walkMinutes(from: Block, to: Block): number | null {
  const a = from.placeId ? PLACES_BY_ID.get(from.placeId) : undefined;
  const b = to.placeId ? PLACES_BY_ID.get(to.placeId) : undefined;
  if (!a || !b) return null;
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null;
  if (a.id === b.id) return 0;

  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const metres = 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)) * STREET_FACTOR;
  return Math.max(1, Math.round(metres / METRES_PER_MINUTE));
}

/**
 * Everything the re-plan may not touch, for a given point in the trip.
 *
 * Locked blocks and blocks that have already started, exactly as §8 step 2 puts
 * them in the same pile. applyDiff is handed this rather than being left to
 * assume, because the accepted list comes back from a browser.
 */
export function immovableIdsAt(blocks: readonly Block[], now: TripNow): Set<string> {
  return new Set(blocks.filter((b) => b.locked === true || hasPassed(b, now)).map((b) => b.id));
}

export function blocksForDay(blocks: readonly Block[], day: number): Block[] {
  return blocks
    .filter((b) => b.day === day)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** The category shown on the budget screen; places carry it, blocks do not. */
export function categoryOf(block: Block): string {
  const place = block.placeId ? PLACES_BY_ID.get(block.placeId) : undefined;
  const raw = place?.category ?? 'other';
  const mapped: Record<string, string> = {
    food: 'Food',
    market: 'Food',
    street: 'Food',
    sight: 'Sights',
    museum: 'Sights',
    temple: 'Sights',
    park: 'Sights',
    'theme-park': 'Tickets',
    shopping: 'Shopping',
  };
  return mapped[raw] ?? 'Other';
}

// ---------------------------------------------------------------------------
// Budget & Split
// ---------------------------------------------------------------------------

/** Who fronted each day. One payer per day is how this group actually did it. */
export const PAYER_BY_DAY: Readonly<Record<number, string>> = {
  1: 'm-wei',
  2: 'm-jia',
  3: 'm-sarah',
  4: 'm-amirah',
  5: 'm-wei',
};

export interface Expense {
  day: number;
  payerId: string;
  /** what the payer put down for the whole group */
  amount: number;
  blockCount: number;
}

/** Expenses are derived from the blocks, so a re-plan changes them too. */
export function expensesOf(
  blocks: readonly Block[],
  memberCount: number = DEMO_MEMBERS.length,
): Expense[] {
  const byDay = new Map<number, { total: number; count: number }>();
  for (const block of blocks) {
    const entry = byDay.get(block.day) ?? { total: 0, count: 0 };
    entry.total += Number.isFinite(block.costPerPerson) ? block.costPerPerson : 0;
    entry.count += 1;
    byDay.set(block.day, entry);
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, entry]) => ({
      day,
      payerId: PAYER_BY_DAY[day] ?? DEMO_MEMBERS[0]!.id,
      amount: entry.total * memberCount,
      blockCount: entry.count,
    }));
}

export interface Transfer {
  fromId: string;
  toId: string;
  amount: number;
}

/**
 * Who owes whom, settled in as few transfers as possible.
 *
 * Everyone's share is the same, so the net position is what they fronted minus
 * that share. Largest debtor pays the largest creditor until nobody is off by
 * more than a ringgit.
 */
export function settleUp(expenses: readonly Expense[], members: readonly Member[]): Transfer[] {
  if (members.length === 0) return [];
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  const share = total / members.length;

  const net = new Map<string, number>(members.map((m) => [m.id, -share]));
  for (const expense of expenses) {
    net.set(expense.payerId, (net.get(expense.payerId) ?? 0) + expense.amount);
  }

  const debtors = [...net.entries()]
    .filter(([, v]) => v < -0.5)
    .sort((a, b) => a[1] - b[1])
    .map(([id, v]) => ({ id, amount: -v }));
  const creditors = [...net.entries()]
    .filter(([, v]) => v > 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => ({ id, amount: v }));

  const transfers: Transfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d]!;
    const creditor = creditors[c]!;
    const amount = Math.min(debtor.amount, creditor.amount);
    if (amount > 0.5) transfers.push({ fromId: debtor.id, toId: creditor.id, amount });
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount <= 0.5) d += 1;
    if (creditor.amount <= 0.5) c += 1;
  }
  return transfers;
}

// ---------------------------------------------------------------------------
// Taste Profile — consensus and conflict, both derived
// ---------------------------------------------------------------------------

export interface ConsensusTag {
  tag: string;
  /** member ids who asked for it */
  memberIds: string[];
}

/** Interests two or more people share, commonest first. */
export function consensusTags(
  preferences: readonly Preference[],
  min = 2,
): ConsensusTag[] {
  const byTag = new Map<string, string[]>();
  for (const pref of preferences) {
    for (const raw of pref.interests ?? []) {
      const tag = raw.trim().toLowerCase();
      if (!tag) continue;
      byTag.set(tag, [...(byTag.get(tag) ?? []), pref.memberId]);
    }
  }
  return [...byTag.entries()]
    .filter(([, ids]) => ids.length >= min)
    .map(([tag, memberIds]) => ({ tag, memberIds }))
    .sort((a, b) => b.memberIds.length - a.memberIds.length || a.tag.localeCompare(b.tag));
}

export type ConflictKind = 'budget' | 'pace' | 'dietary' | 'interest';

export interface Conflict {
  kind: ConflictKind;
  title: string;
  detail: string;
  /** what the captain's override actually did about it */
  resolution: string;
  memberIds: string[];
}

const BAND_WORDS: Record<string, string> = {
  low: 'keeping it cheap',
  mid: 'a middle budget',
  high: 'happy to spend',
};

const PACE_WORDS: Record<string, string> = {
  chill: 'a slow trip',
  balanced: 'a balanced trip',
  packed: 'a packed trip',
};

/**
 * Where the group actually disagrees.
 *
 * Pure set arithmetic over the preferences — no model, no scoring. The captain
 * gets told what the disagreement is and what was done about it; the product's
 * position is that group input is required but group decisions are not.
 */
export function findConflicts(
  preferences: readonly Preference[],
  members: readonly Member[],
): Conflict[] {
  const nameOf = (id: string): string =>
    members.find((m) => m.id === id)?.displayName ?? 'Someone';
  const out: Conflict[] = [];

  const low = preferences.filter((p) => p.budgetBand === 'low');
  const high = preferences.filter((p) => p.budgetBand === 'high');
  if (low.length > 0 && high.length > 0) {
    out.push({
      kind: 'budget',
      title: 'Budget',
      detail:
        `${low.map((p) => nameOf(p.memberId)).join(' and ')} asked for ${BAND_WORDS['low']}; ` +
        `${high.map((p) => nameOf(p.memberId)).join(' and ')} is ${BAND_WORDS['high']}.`,
      resolution:
        'The ceiling follows the lowest band, never the average — nobody is quietly committed to a trip they cannot afford.',
      memberIds: [...low, ...high].map((p) => p.memberId),
    });
  }

  const chill = preferences.filter((p) => p.pace === 'chill');
  const packed = preferences.filter((p) => p.pace === 'packed');
  if (chill.length > 0 && packed.length > 0) {
    out.push({
      kind: 'pace',
      title: 'Pace',
      detail:
        `${chill.map((p) => nameOf(p.memberId)).join(' and ')} wants ${PACE_WORDS['chill']}; ` +
        `${packed.map((p) => nameOf(p.memberId)).join(' and ')} wants ${PACE_WORDS['packed']}.`,
      resolution:
        'The pace vote goes to the majority and ties fall back to balanced, so the plan runs at four blocks a day.',
      memberIds: [...chill, ...packed].map((p) => p.memberId),
    });
  }

  const diets = new Map<string, string[]>();
  for (const pref of preferences) {
    for (const raw of pref.dietary ?? []) {
      const tag = raw.trim().toLowerCase();
      if (!tag) continue;
      diets.set(tag, [...(diets.get(tag) ?? []), pref.memberId]);
    }
  }
  if (diets.size >= 2) {
    out.push({
      kind: 'dietary',
      title: 'Dietary',
      detail: [...diets.entries()]
        .map(([tag, ids]) => `${ids.map(nameOf).join(' and ')}: ${tag}`)
        .join(' · '),
      resolution:
        'Every meal block has to clear all of them at once. Somewhere that suits one person and not another does not go on the plan.',
      memberIds: [...new Set([...diets.values()].flat())],
    });
  }

  for (const pref of preferences) {
    for (const raw of (pref.noGo ?? '').split(/[,;、，]/)) {
      const token = raw.trim().toLowerCase();
      if (!token) continue;
      const clashes = preferences.filter(
        (other) =>
          other.memberId !== pref.memberId &&
          (other.interests ?? []).some((i) => i.toLowerCase().includes(token)),
      );
      if (clashes.length === 0) continue;
      out.push({
        kind: 'interest',
        title: 'Interests',
        detail: `${nameOf(pref.memberId)} ruled out ${token}; ${clashes
          .map((c) => nameOf(c.memberId))
          .join(' and ')} asked for it.`,
        resolution: 'A no-go is a hard filter — anything matching it is dropped from the candidates before the plan is built.',
        memberIds: [pref.memberId, ...clashes.map((c) => c.memberId)],
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Photos and addresses — fetched, not written
// ---------------------------------------------------------------------------

/**
 * A place's photo and street address.
 *
 * Keyed by placeId rather than by block, for three reasons: `Block` is defined by
 * BlockSchema, which is the frozen contract with the AI role and not ours to
 * extend; applyDiff() rebuilds a re-plan's added blocks field by field, so an
 * extra property on a block object would be dropped exactly where it is most
 * wanted; and a photo is a fact about a place, not about a slot in a day —
 * `usj` and `dotonbori` each carry two blocks and should not disagree with
 * themselves.
 *
 * Generated by scripts kept out of the repo, from two sources:
 *   - imageUrl / license / artist   Wikimedia Commons, via the MediaWiki API
 *   - address                       OpenStreetMap Nominatim, reverse-geocoded
 *                                   from the lat/lng already in seeds/
 *
 * Nothing here is invented. A place with no usable CC photo simply has no entry,
 * and the UI falls back to a tile rather than showing a photo of somewhere else.
 */
const PlaceMediaSchema = z.object({
  /** an 800px-wide Commons thumbnail; narrow it with thumbAt() */
  imageUrl: z.url(),
  /** e.g. 'CC BY-SA 4.0' — displayed verbatim next to the photo */
  license: z.string(),
  artist: z.string().nullable(),
  /** the Commons file page, for attribution */
  fileUrl: z.url(),
  address: z.string().nullable(),
});
export type PlaceMedia = z.infer<typeof PlaceMediaSchema>;

export const PLACE_MEDIA: Record<string, PlaceMedia> = z
  .record(z.string(), PlaceMediaSchema)
  .parse(rawMedia);

export function mediaForPlace(placeId: string | null | undefined): PlaceMedia | undefined {
  return placeId ? PLACE_MEDIA[placeId] : undefined;
}

/** The photo and address behind a block, resolved through its place. */
export function mediaFor(block: Pick<Block, 'placeId'>): PlaceMedia | undefined {
  return mediaForPlace(block?.placeId);
}

export function addressOf(block: Pick<Block, 'placeId'>): string | null {
  return mediaFor(block)?.address ?? null;
}

/**
 * Commons only renders a fixed set of thumbnail widths — anything else comes
 * back 400 with "Use thumbnail sizes listed on ...". These are the buckets that
 * answered when probed; a request is rounded up to the next one so a 64px list
 * icon does not pull the 1920px copy.
 */
export const THUMB_WIDTHS = [120, 250, 500, 960, 1920] as const;

export function thumbAt(url: string, width: number): string {
  const bucket = THUMB_WIDTHS.find((w) => w >= width) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]!;
  const cut = url.lastIndexOf('/');
  if (cut < 0) return url;
  const last = url.slice(cut + 1).replace(/(^|-)(\d+)px-/, `$1${bucket}px-`);
  return `${url.slice(0, cut + 1)}${last}`;
}

// ---------------------------------------------------------------------------
// Why a replacement was picked — derived for the re-plan diff
// ---------------------------------------------------------------------------

/** Interest words a place plausibly answers to, from its own category and name. */
function interestTagsFor(place: Place | undefined): string[] {
  if (!place) return [];
  const byCategory: Record<string, string[]> = {
    food: ['street food'],
    market: ['street food'],
    street: ['street food', 'nightlife'],
    museum: ['museums'],
    park: ['parks'],
    temple: ['history', 'architecture'],
    sight: ['views', 'architecture'],
    'theme-park': ['theme parks'],
    shopping: ['shopping'],
  };
  const tags = new Set(byCategory[place.category ?? ''] ?? []);
  const name = place.name.toLowerCase();
  if (/tower|observator|sky|wheel|harukas/.test(name)) tags.add('views');
  if (/castle|temple|shrine|taisha|ji$/.test(name)) tags.add('history');
  return [...tags];
}

/** The one sentence that says why the original plan stopped working. */
function disruptionSentence(scenario: DemoScenario, diff: StoredDiff): string {
  const d = scenario.disruption;
  switch (d.type) {
    case 'delay':
      return `Day ${d.day} cannot start before ${diff.window.earliestStart} — you land ${d.payload.hours} hours late.`;
    case 'weather':
      return `Day ${d.day} is ${d.payload?.condition ?? 'bad weather'}, so anything open to the sky is out.`;
    case 'closed':
      return `${PLACES_BY_ID.get(d.payload.placeId)?.name ?? d.payload.placeId} is closed on day ${d.day}.`;
    case 'overbudget':
      return `${formatRM(diff.shortfall)} per person had to come off the trip.`;
  }
}

export interface ReplacementWhy {
  constraint: string;
  budget: string;
  votes: string;
  source: KnowledgeChunk | null;
}

/**
 * The four "Why this" lines for a block a re-plan wants to add.
 *
 * All four are worked out here rather than stored, so they cannot drift from the
 * diff they describe:
 *   CONSTRAINT  the disruption, plus what this candidate does about it
 *   BUDGET      its own cost against what the same diff takes off
 *   VOTES       whose stated interests and must-dos it actually answers
 *   SOURCE      a chunk the retrieval layer returned for this district or this
 *               kind of place — never one picked to sound relevant
 */
export function replacementWhy(
  entry: DiffOp,
  scenario: DemoScenario,
  diff: StoredDiff,
  preferences: readonly Preference[],
  members: readonly Member[],
  blocksById: ReadonlyMap<string, Block>,
): ReplacementWhy | null {
  if (entry.op.op !== 'add') return null;
  const draft = entry.op.block;
  const place = PLACES_BY_ID.get(draft.placeId);
  const nameOf = (id: string): string =>
    members.find((m) => m.id === id)?.displayName ?? 'Someone';

  // --- CONSTRAINT ---
  // A closure already names the place it took out, so do not say it twice.
  const alreadyNamed =
    scenario.disruption.type === 'closed' ? scenario.disruption.payload.placeId : null;
  const removed = diff.ops
    .filter((o) => o.op.op === 'remove')
    .map((o) => (o.op.op === 'remove' ? blocksById.get(o.op.blockId) : null))
    .filter((b): b is Block => Boolean(b) && b!.placeId !== alreadyNamed)
    .map((b) => b.title);
  // Several removals rarely map one-to-one onto one addition, so this says what
  // the diff does rather than claiming this block replaces all of them.
  const replaces = removed.length > 0 ? ` The same diff drops ${removed.join(', ')}.` : '';
  const own = draft.reason?.constraint ? ` ${draft.reason.constraint}` : '';
  const constraint = `${disruptionSentence(scenario, diff)}${replaces}${own}`;

  // --- BUDGET ---
  const removedTotal = diff.ops
    .filter((o) => o.op.op === 'remove')
    .reduce((sum, o) => sum + Math.abs(o.costDelta), 0);
  const budget =
    `${formatRM(draft.costPerPerson)} per person` +
    (removedTotal > 0
      ? ` against the ${formatRM(removedTotal)} coming off — the whole diff is ${formatDelta(diff.budgetDelta)}.`
      : `, and the whole diff is ${formatDelta(diff.budgetDelta)}.`);

  // --- VOTES ---
  const tags = interestTagsFor(place);
  const haystack = [draft.title, draft.subtitle, place?.name, place?.category, place?.district]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const hits: string[] = [];
  for (const pref of preferences) {
    const shared = (pref.interests ?? []).filter((i) => tags.includes(i.toLowerCase()));
    if (shared.length > 0) hits.push(`${nameOf(pref.memberId)}’s ${listOf(shared)}`);
    const must = (pref.mustDo ?? '').trim();
    if (must && matchesMustDo(must, haystack)) {
      hits.push(`${nameOf(pref.memberId)}’s must-do “${must}”`);
    }
  }

  const clears = [
    place?.vegFriendly ? 'vegetarian' : null,
    place?.indoor ? 'indoors' : null,
  ].filter((v): v is string => Boolean(v));

  const votes =
    hits.length > 0
      ? `Matches ${listOf([...new Set(hits)])}. No vote has been taken — this is a proposal.`
      : `Nobody asked for this one by name; it is here because the slot needed filling${
          clears.length > 0 ? ` and it clears ${listOf(clears)}` : ''
        }.`;

  // --- SOURCE ---
  // Strict on purpose. Matching on district or tag looked generous and was
  // wrong: it paired Amerikamura with a line about Osaka Castle, because both
  // sit in Chuo. A chunk only counts if it actually names this place, which for
  // most candidates means no chunk counts and the row says so.
  const source =
    diff.citations.find((c) => namesPlace(c.chunk, place?.name ?? draft.title)) ??
    knowledgeFor(draft.placeId);

  return { constraint, budget, votes, source };
}

/**
 * Words too common to identify a place. The city name is the dangerous one: on
 * first-word matching, Wei's must-do "Osaka Castle" would claim credit for every
 * place in Osaka, which is precisely the kind of quiet overclaim this screen
 * exists to avoid.
 */
const GENERIC_PLACE_WORDS = new Set([
  'osaka',
  'japan',
  'the',
  'and',
  'market',
  'street',
  'park',
  'museum',
  'temple',
  'shrine',
  'food',
  'hall',
  'centre',
  'center',
  'city',
  'town',
]);

/** True when the retrieved text actually names this place, not merely its area. */
function namesPlace(chunk: string, placeName: string): boolean {
  const haystack = chunk.toLowerCase();
  const distinctive = placeName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5 && !GENERIC_PLACE_WORDS.has(word));
  return distinctive.length > 0 && distinctive.some((word) => haystack.includes(word));
}

/** True only when a distinctive word from the must-do actually names this place. */
function matchesMustDo(mustDo: string, haystack: string): boolean {
  const distinctive = mustDo
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC_PLACE_WORDS.has(word));
  return distinctive.length > 0 && distinctive.some((word) => haystack.includes(word));
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// What the taste layer holds about each place
// ---------------------------------------------------------------------------

/**
 * One retrieved fact per place, with its source.
 *
 * The mock corpus in lib/__mocks__/knowledge.ts covers six places, which is
 * enough to prove citations flow through the pipeline but leaves most candidates
 * with nothing to cite. This fills the gap the only honest way: real lead text
 * from the English Wikipedia article for that exact place, fetched once and
 * committed, with the article named and linked.
 *
 * It is a fallback, never an override — a chunk the retriever actually returned
 * wins. And a place with no entry still shows the empty state rather than
 * borrowing a sentence about somewhere else.
 */
export const PLACE_KNOWLEDGE: Record<string, KnowledgeChunk> = z
  .record(z.string(), KnowledgeChunkSchema)
  .parse(rawKnowledge);

export function knowledgeFor(placeId: string | null | undefined): KnowledgeChunk | null {
  return (placeId ? PLACE_KNOWLEDGE[placeId] : null) ?? null;
}

/** The citation to show for a block: what the pipeline attached, else what we hold. */
export function citationFor(block: Pick<Block, 'placeId' | 'sourceCitation'>): SourceCitation | null {
  if (block?.sourceCitation) return block.sourceCitation;
  const known = knowledgeFor(block?.placeId);
  return known ? { text: known.chunk, source: known.source, url: known.url ?? null } : null;
}
