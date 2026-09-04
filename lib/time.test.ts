import { describe, expect, it } from 'vitest';

import { CITY_TIMEZONES, toTripLocal, tripTimezone } from './time';
import type { Trip } from './schemas';

const OSAKA: Pick<Trip, 'cityKey' | 'startDate' | 'timezone'> = {
  cityKey: 'osaka',
  startDate: '2026-09-07',
  timezone: 'Asia/Tokyo',
};

describe('tripTimezone', () => {
  it('prefers the trip’s own zone', () => {
    expect(tripTimezone({ cityKey: 'osaka', timezone: 'Europe/Berlin' })).toBe('Europe/Berlin');
  });

  it('falls back to the cityKey map while trips.timezone does not exist yet', () => {
    expect(tripTimezone({ cityKey: 'osaka', timezone: null })).toBe('Asia/Tokyo');
    expect(tripTimezone({ cityKey: 'OSAKA', timezone: undefined })).toBe('Asia/Tokyo');
    expect(CITY_TIMEZONES['osaka']).toBe('Asia/Tokyo');
  });

  it('falls back to UTC for a city nobody has mapped', () => {
    expect(tripTimezone({ cityKey: 'atlantis', timezone: null })).toBe('UTC');
  });

  it('ignores a blank timezone rather than trusting it', () => {
    expect(tripTimezone({ cityKey: 'osaka', timezone: '   ' })).toBe('Asia/Tokyo');
  });
});

describe('toTripLocal', () => {
  it('reads the instant in the trip’s zone, not the runner’s', () => {
    // Tokyo is UTC+9, so 00:30Z on the first day is 09:30 local
    expect(toTripLocal('2026-09-07T00:30:00Z', OSAKA)).toEqual({ day: 1, time: '09:30' });
  });

  it('rolls into the next day when the local date has moved on', () => {
    // 15:00Z is midnight in Tokyo, which is already day 2
    expect(toTripLocal('2026-09-07T15:00:00Z', OSAKA)).toEqual({ day: 2, time: '00:00' });
    expect(toTripLocal('2026-09-08T14:59:00Z', OSAKA)).toEqual({ day: 2, time: '23:59' });
  });

  it('counts days from the trip’s start date', () => {
    expect(toTripLocal('2026-09-11T03:00:00Z', OSAKA)?.day).toBe(5);
  });

  it('is allowed to sit outside the trip', () => {
    // The day before the trip starts, in local terms
    expect(toTripLocal('2026-09-06T05:00:00Z', OSAKA)).toEqual({ day: 0, time: '14:00' });
    expect(toTripLocal('2026-09-20T03:00:00Z', OSAKA)?.day).toBe(14);
  });

  it('handles a zone behind UTC', () => {
    const ny = { cityKey: 'newyork', startDate: '2026-09-07', timezone: 'America/New_York' };
    // 02:00Z on the 7th is still 22:00 on the 6th in New York — the day before
    expect(toTripLocal('2026-09-07T02:00:00Z', ny)).toEqual({ day: 0, time: '22:00' });
  });

  it('lets Intl handle daylight saving rather than keeping a table', () => {
    const ny = { cityKey: 'newyork', startDate: '2026-03-07', timezone: 'America/New_York' };
    // 2026-03-08 is when US clocks go forward: UTC-5 before, UTC-4 after
    expect(toTripLocal('2026-03-08T05:30:00Z', ny)).toEqual({ day: 2, time: '00:30' });
    expect(toTripLocal('2026-03-08T12:00:00Z', ny)).toEqual({ day: 2, time: '08:00' });
  });

  it('returns null rather than a wrong day when it cannot tell', () => {
    expect(toTripLocal('not a timestamp', OSAKA)).toBeNull();
    expect(toTripLocal('2026-09-07T00:30:00Z', { ...OSAKA, startDate: 'soon' })).toBeNull();
    expect(toTripLocal('2026-09-07T00:30:00Z', { ...OSAKA, startDate: '' })).toBeNull();
  });

  it('falls back to UTC on an unrecognised zone instead of throwing', () => {
    const broken = { cityKey: 'osaka', startDate: '2026-09-07', timezone: 'Mars/Olympus_Mons' };
    expect(() => toTripLocal('2026-09-07T00:30:00Z', broken)).not.toThrow();
    expect(toTripLocal('2026-09-07T00:30:00Z', broken)).toEqual({ day: 1, time: '00:30' });
  });

  it('produces exactly what replan takes as `now`', () => {
    const now = toTripLocal('2026-09-08T05:00:00Z', OSAKA);
    expect(now).toEqual({ day: 2, time: '14:00' });
    expect(typeof now?.day).toBe('number');
    expect(now?.time).toMatch(/^\d{2}:\d{2}$/);
  });
});
