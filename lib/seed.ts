/**
 * lib/seed.ts — the fallback data, parsed once and typed.
 *
 * §11 makes the seed the last line of defence: when Gemini is down, rate-limited,
 * or talking nonsense, this is what the demo shows. Both files are parsed through
 * their Zod schemas at import, so a malformed seed fails in CI rather than on stage.
 *
 * generate.ts uses it for the fallback; the mocks under __mocks__/ use it to play
 * the part of a well-behaved model and a populated places table.
 */

import rawPlaces from '../seeds/osaka-places.json';
import rawSeed from '../seeds/osaka-trip.json';
import {
  PlaceSchema,
  SeedItinerarySchema,
  type ItineraryDraft,
  type Place,
  type SeedItinerary,
} from './schemas';

/** seeds/osaka-places.json — the 30 prefetched Osaka candidates (§10: prefetched, never live) */
export const SEED_PLACES: Place[] = PlaceSchema.array().parse(rawPlaces);

/** seeds/osaka-trip.json — a 4-person, 5-day Osaka itinerary that validates against itself */
export const SEED_ITINERARY: SeedItinerary = SeedItinerarySchema.parse(rawSeed);

/**
 * The seed reshaped as if a model had returned it.
 *
 * Used by MockLLMClient as its default reply, and useful in tests as a known-good
 * draft. `id`, `locked` and `createdBy` are dropped because the model never gets
 * to set those.
 */
export function seedAsDraft(seed: SeedItinerary = SEED_ITINERARY): ItineraryDraft {
  return {
    blocks: seed.blocks.map((b) => ({
      day: b.day,
      startTime: b.startTime,
      durationMin: b.durationMin,
      title: b.title,
      subtitle: b.subtitle ?? null,
      placeId: b.placeId ?? '',
      costPerPerson: b.costPerPerson,
      reason: b.reason ?? null,
      sourceCitation: b.sourceCitation ?? null,
    })),
    summary: `${seed.blocks.length} blocks across ${seed.trip.startDate} – ${seed.trip.endDate}.`,
  };
}
