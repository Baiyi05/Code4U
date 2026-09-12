/**
 * lib/time.ts — the one place in lib/ that knows what a timezone is.
 *
 * The engines (constraints, generate, replan) work in { day, time }: a 1-based
 * day index into the trip and a wall-clock 'HH:MM'. No Date, no zone, no system
 * clock — that is what makes them testable.
 *
 * Somebody still has to turn a real instant into that pair, and this is where it
 * happens: at the route-handler boundary, on the way in. replan.ts does not
 * import this file, and should not.
 */

import { ISO_DATE_RE, type Trip } from './schemas';

/**
 * cityKey → IANA zone, used until trips.timezone exists as a column.
 *
 * Extend it as cities are added. An unknown city falls back to UTC, which is
 * wrong by up to a day at the edges — so a real trip should carry its own
 * timezone rather than rely on this.
 */
export const CITY_TIMEZONES: Readonly<Record<string, string>> = {
  osaka: 'Asia/Tokyo',
  tokyo: 'Asia/Tokyo',
  kyoto: 'Asia/Tokyo',
  seoul: 'Asia/Seoul',
  taipei: 'Asia/Taipei',
  singapore: 'Asia/Singapore',
  bangkok: 'Asia/Bangkok',
  kualalumpur: 'Asia/Kuala_Lumpur',
  'kuala-lumpur': 'Asia/Kuala_Lumpur',
};

const FALLBACK_ZONE = 'UTC';
const MS_PER_DAY = 86_400_000;

/** The zone to read a trip's local time in. */
export function tripTimezone(trip: Pick<Trip, 'cityKey' | 'timezone'>): string {
  if (typeof trip?.timezone === 'string' && trip.timezone.trim()) return trip.timezone.trim();
  const key = typeof trip?.cityKey === 'string' ? trip.cityKey.trim().toLowerCase() : '';
  return CITY_TIMEZONES[key] ?? FALLBACK_ZONE;
}

export interface TripLocal {
  /** 1-based index into the trip; can be <1 before it starts or >days after it ends */
  day: number;
  /** 'HH:MM' local to the trip */
  time: string;
}

interface LocalParts {
  year: number;
  month: number;
  dayOfMonth: number;
  hour: number;
  minute: number;
}

/**
 * Split an instant into calendar parts as seen in `timeZone`.
 *
 * Intl is doing the DST and offset work; there is no table here to go stale.
 * An unrecognised zone makes the formatter throw, so it falls back to UTC rather
 * than taking the request down.
 */
function partsIn(instant: Date, timeZone: string): LocalParts {
  const read = (zone: string): LocalParts => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const found: Record<string, string> = {};
    for (const part of fmt.formatToParts(instant)) {
      if (part.type !== 'literal') found[part.type] = part.value;
    }
    return {
      year: Number(found['year']),
      month: Number(found['month']),
      dayOfMonth: Number(found['day']),
      // Intl renders midnight as '24' in some locales/zones; normalise it
      hour: Number(found['hour']) % 24,
      minute: Number(found['minute']),
    };
  };

  try {
    return read(timeZone);
  } catch {
    return read(FALLBACK_ZONE);
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Turn a real timestamp into the { day, time } the engines take.
 *
 * `iso` is anything Date can parse — normally an ISO-8601 instant from the
 * server. The day index counts calendar days in the trip's own zone from
 * trip.startDate, so day 1 is the first day of the trip.
 *
 * Returns null when the timestamp or the trip's start date is unreadable, so the
 * caller decides what to do rather than getting a silently wrong day.
 */
export function toTripLocal(
  iso: string,
  trip: Pick<Trip, 'cityKey' | 'startDate' | 'timezone'>,
): TripLocal | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  const startMatch = ISO_DATE_RE.exec(String(trip?.startDate ?? '').trim());
  if (!startMatch) return null;

  const zone = tripTimezone(trip);
  const local = partsIn(instant, zone);

  // Both sides are plain calendar dates by this point, so a UTC subtraction is
  // exact: no offset or DST can leak in.
  const startUTC = Date.UTC(Number(startMatch[1]), Number(startMatch[2]) - 1, Number(startMatch[3]));
  const localUTC = Date.UTC(local.year, local.month - 1, local.dayOfMonth);

  return {
    day: Math.round((localUTC - startUTC) / MS_PER_DAY) + 1,
    time: `${pad2(local.hour)}:${pad2(local.minute)}`,
  };
}
