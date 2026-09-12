/**
 * lib/__mocks__/places.ts — the prefetched `places` table, without Supabase.
 *
 * Backed by seeds/osaka-places.json: 30 real Osaka candidates with opening hours,
 * costs and durations. §10 says the demo never calls Google Places live anyway, so
 * this is the same data the real repository will be serving.
 *
 * The real repository is the Database role's job.
 */

import { SEED_PLACES } from '../seed';
import type { PlaceRepository } from '../generate';
import type { Place } from '../schemas';

export class MockPlaceRepository implements PlaceRepository {
  /** Every cityKey it was asked for, in order. */
  readonly calls: string[] = [];

  private readonly places: readonly Place[];

  constructor(places: readonly Place[] = SEED_PLACES) {
    this.places = places;
  }

  async byCity(cityKey: string): Promise<Place[]> {
    this.calls.push(cityKey);
    return this.places.filter((p) => p.cityKey === cityKey);
  }
}

/** A repository that always throws — for testing the fallback chain. */
export class FailingPlaceRepository implements PlaceRepository {
  constructor(private readonly error: Error = new Error('places table unreachable')) {}

  async byCity(): Promise<Place[]> {
    throw this.error;
  }
}
